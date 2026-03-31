import fs from 'fs';
import path from 'path';
import { AgentAdapter } from './base.js';

const NATIVE_REVIEWER_CONFIG = {
  name: 'native-reviewer',
  type: 'api',
  capabilities: ['code-review', 'quality-assurance']
};

export class NativeReviewerAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...NATIVE_REVIEWER_CONFIG, ...config });
    this.apiKey = process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY || config.api_key;
    this.apiHost = process.env.OPENAI_API_BASE || process.env.MINIMAX_API_HOST || config.api_host || 'https://api.minimaxi.com';
    this.model = process.env.OPENAI_MODEL || process.env.MINIMAX_API_MODEL || config.model || 'MiniMax-Text-01';
  }

  async healthCheck() {
    return !!this.apiKey;
  }

  async execute(task) {
    const startTime = Date.now();
    try {
      if (!this.apiKey) {
         throw new Error('API Key missing. Please set OPENAI_API_KEY or MINIMAX_API_KEY for native-reviewer');
      }

      const systemPrompt = `你是一个非常严厉的资深代码审查员。
你的任务是审查由 AI 刚生成的代码。
请严格挑出代码中的潜在 bug、可维护性问题和不优雅的写法。

评分标准：
- 90-100: 代码质量优秀，无需修改
- 70-89: 基本合格，有少量可优化项
- 60-69: 基本可用，需修复一些次要问题
- 50-59: 不可接受，需修复多个重要问题
- <50: 严重问题，必须完全重写

输出必须是一段合法的纯 JSON 对象，格式如下：
{
  "score": 0到100的分数,
  "summary": "总体评价 (一句话)",
  "issues": [
    {
      "severity": "CRITICAL | WARNING | INFO",
      "title": "问题标题",
      "file": "相关文件路径",
      "reason": "为什么这是问题",
      "suggestion": "具体修改建议"
    }
  ]
}

要求：
- 至少找到 3 个问题（除非代码确实完美）
- CRITICAL 必须包含具体代码行号或位置
- 不要遗漏任何潜在的 bug 或安全问题
- 如果没有问题，score 设为 100，issues 设为空数组
不要包含任何 Markdown 标签或额外文字。`;

      // 获取需要 review 的文件内容
      let codeToReview = "无需审查 (没有任何文件被创建或修改)";
      if (task.context && task.context.code_result) {
         const cr = task.context.code_result.output;
         const filesToRead = [...(cr.files_created || []), ...(cr.files_modified || [])];
         
         const fileContents = [];
         for (const filepath of filesToRead) {
            try {
               const fullPath = path.join(task.context.project_root, filepath);
               const content = fs.readFileSync(fullPath, 'utf-8');
               fileContents.push(`--- 文件: ${filepath} ---\n${content}\n`);
            } catch(e) {
              // Ignore individual file read errors
            }
         }
         if (fileContents.length > 0) {
            codeToReview = fileContents.join('\n');
         }
      }

      const userPrompt = `项目需求: ${task.description}\n${task.context?.architecture_rules ? `\n项目架构规范:\n${task.context.architecture_rules.substring(0, 500)}...` : ''}\n${task.context?.quality_rules ? `\n质量规范:\n${task.context.quality_rules.substring(0, 500)}...` : ''}\n\n请审查以下修改的文件内容:\n${codeToReview}\n\n请输出严格的 JSON 审查结果，包括评分、总体评价和具体问题列表。`;

      const endpoint = this.apiHost.endsWith('/v1') 
          ? `${this.apiHost}/chat/completions` 
          : `${this.apiHost}/v1/chat/completions`;

      console.log(`[${this.name}] 请求原生 API 进行代码审查... (Model: ${this.model})`);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3
        }),
        signal: AbortSignal.timeout(120000)
      });

      if (!res.ok) {
        throw new Error(`API Error ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      
      if (!data.choices || data.choices.length === 0) {
        throw new Error(`API 响应结构异常`);
      }
      
      const contentStr = data.choices[0].message.content;
      const resultObj = this._extractJSON(contentStr);

      return this._formatResult({
        task_id: task.id,
        success: true,
        score: typeof resultObj.score === 'number' ? resultObj.score : 80,
        summary: resultObj.summary || resultObj.comments || '无评价',
        issues: resultObj.issues || [],
        duration_ms: Date.now() - startTime
      }, startTime);

    } catch (error) {
       console.error(`[${this.name}] 执行异常: `, error.message);
       return this.handleError(error);
    }
  }

  _extractJSON(output) {
    if (typeof output !== 'string') return output;
    const codeBlocks = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    const textToParse = codeBlocks.length > 0 ? codeBlocks[codeBlocks.length - 1][1].trim() : output;

    const startObj = textToParse.indexOf('{');
    const endObj = textToParse.lastIndexOf('}');
    if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
        try {
            return JSON.parse(textToParse.substring(startObj, endObj + 1));
        } catch(e) {
          // JSON parse failure handled by fallback
        }
    }
    return { score: 70, comments: "JSON parse failed, string matching failed.", issues: [] };
  }

  _formatResult(rawResult, startTime) {
    return {
      task_id: rawResult.task_id || 'unknown',
      agent: this.name,
      status: rawResult.success ? 'success' : 'failed',
      output: {
        score: rawResult.score,
        summary: rawResult.summary,
        issues: rawResult.issues || [],
        tests_run: false
      },
      metrics: {
        duration_ms: rawResult.duration_ms || (Date.now() - startTime),
        tokens_used: 0
      },
      errors: rawResult.errors || []
    };
  }
}
