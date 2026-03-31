/**
 * Native Reviewer Adapter - AI 代码审查 Agent
 * 
 * 集成 UniversalToolbox，支持：
 * - 文件读取工具
 * - Bash 命令执行
 * - LSP 代码诊断
 * - Git 操作
 */

import { AgentAdapter } from './base.js';
import { jsonrepair } from 'jsonrepair';

const NATIVE_REVIEWER_CONFIG = {
  name: 'native-reviewer',
  type: 'api',
  capabilities: ['code-review', 'quality-assurance', 'static-analysis']
};

export class NativeReviewerAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...NATIVE_REVIEWER_CONFIG, ...config });
    this.apiKey = process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY || config.api_key;
    this.apiHost = process.env.OPENAI_API_BASE || process.env.MINIMAX_API_HOST || config.api_host || 'https://api.minimaxi.com';
    this.model = process.env.OPENAI_MODEL || process.env.MINIMAX_API_MODEL || config.model || 'MiniMax-Text-01';
    
    if (config.project_root) {
      this.toolbox.config.workspace_root = config.project_root;
    }
  }

  async healthCheck() {
    return !!this.apiKey;
  }

  /**
   * 获取工具描述供 LLM 使用
   * @private
   */
  _getToolsDescription() {
    const tools = this.getTools();
    const categories = {
      file: tools.filter(t => t.category === 'file_system').slice(0, 4),
      bash: tools.filter(t => t.category === 'bash').slice(0, 2),
      git: tools.filter(t => t.category === 'git'),
      lsp: tools.filter(t => t.category === 'lsp')
    };

    let desc = '';
    
    if (categories.file.length) {
      desc += '\n【文件读取工具】\n';
      categories.file.forEach(t => {
        if (t.name.includes('read') || t.name.includes('file')) {
          desc += `- ${t.name}: ${t.description}\n`;
        }
      });
    }
    
    if (categories.lsp.length) {
      desc += '\n【LSP 代码分析工具】\n';
      categories.lsp.forEach(t => {
        desc += `- ${t.name}: ${t.description}\n`;
      });
    }
    
    if (categories.git.length) {
      desc += '\n【Git 工具】\n';
      categories.git.forEach(t => {
        desc += `- ${t.name}: ${t.description}\n`;
      });
    }
    
    return desc;
  }

  /**
   * 使用工具批量读取文件
   * @private
   */
  async _readFilesForReview(filePaths, projectRoot) {
    const contents = [];
    
    for (const filepath of filePaths) {
      const result = await this.executeTool('read_file', { file_path: filepath });
      if (result.success) {
        contents.push({
          path: filepath,
          content: result.result.content,
          size: result.result.size
        });
      }
    }
    
    return contents;
  }

  /**
   * 获取 LSP 诊断信息
   * @private
   */
  async _getLspDiagnostics(filePaths) {
    const diagnostics = [];
    
    for (const filepath of filePaths) {
      const result = await this.executeTool('lsp_diagnostics', {
        file_path: filepath,
        language_server: 'typescript'
      });
      if (result.success && result.result) {
        diagnostics.push({
          file: filepath,
          issues: result.result
        });
      }
    }
    
    return diagnostics;
  }

  /**
   * 获取 Git diff 信息
   * @private
   */
  async _getGitDiff(projectRoot) {
    const result = await this.executeTool('git_diff', { cwd: projectRoot });
    return result.success ? result.result.stdout : '';
  }

  async execute(task) {
    const startTime = Date.now();
    try {
      if (!this.apiKey) {
        throw new Error('API Key missing. Please set OPENAI_API_KEY or MINIMAX_API_KEY for native-reviewer');
      }

      const projectRoot = task.context?.project_root || '.';
      const toolsDescription = this._getToolsDescription();

      let codeToReview = "无需审查 (没有任何文件被创建或修改)";
      let filesReviewed = [];

      if (task.context?.code_result) {
        const cr = task.context.code_result.output || task.context.code_result;
        const filesToRead = [...(cr.files_created || []), ...(cr.files_modified || [])];
        
        if (filesToRead.length > 0) {
          const fileContents = await this._readFilesForReview(filesToRead, projectRoot);
          
          if (fileContents.length > 0) {
            codeToReview = fileContents
              .map(f => `--- 文件: ${f.path} (${f.size} bytes) ---\n${f.content}\n`)
              .join('\n');
            filesReviewed = fileContents.map(f => f.path);
            
            const lspDiagnostics = await this._getLspDiagnostics(filesToRead);
            if (lspDiagnostics.length > 0) {
              codeToReview += '\n\n--- LSP 诊断信息 ---\n';
              codeToReview += JSON.stringify(lspDiagnostics, null, 2);
            }
          }
        }
      }

      const gitDiff = await this._getGitDiff(projectRoot);
      if (gitDiff) {
        codeToReview += '\n\n--- Git Diff ---\n' + gitDiff.substring(0, 2000);
      }

      const systemPrompt = `你是一个非常严厉的资深代码审查员。
你的任务是审查由 AI 刚生成的代码。
请严格挑出代码中的潜在 bug、可维护性问题和不优雅的写法。

## 可用工具
${toolsDescription}

## 评分标准
- 90-100: 代码质量优秀，无需修改
- 70-89: 基本合格，有少量可优化项
- 60-69: 基本可用，需修复一些次要问题
- 50-59: 不可接受，需修复多个重要问题
- <50: 严重问题，必须完全重写

## 输出格式
输出必须是一段合法的纯 JSON 对象，格式如下：
{
  "score": 0到100的分数,
  "summary": "总体评价 (一句话)",
  "issues": [
    {
      "severity": "CRITICAL | WARNING | INFO",
      "title": "问题标题",
      "file": "相关文件路径",
      "line": "相关行号(可选)",
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

      const userPrompt = `## 项目需求
${task.description}

${task.context?.architecture_rules ? `## 架构规范\n${task.context.architecture_rules.substring(0, 800)}\n` : ''}
${task.context?.quality_rules ? `## 质量规范\n${task.context.quality_rules.substring(0, 800)}\n` : ''}

## 待审查文件
${filesReviewed.length > 0 ? filesReviewed.map(f => `- ${f}`).join('\n') : '无'}

## 代码内容
${codeToReview}

请输出严格的 JSON 审查结果。`;

      const endpoint = this.apiHost.endsWith('/v1') 
          ? `${this.apiHost}/chat/completions` 
          : `${this.apiHost}/v1/chat/completions`;

      console.log(`[${this.name}] 请求原生 API 进行代码审查... (Model: ${this.model})`);
      console.log(`[${this.name}] 审查文件数: ${filesReviewed.length}`);

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
        files_reviewed: filesReviewed,
        duration_ms: Date.now() - startTime
      }, startTime);

    } catch (error) {
      console.error(`[${this.name}] 执行异常: `, error.message);
      return this.handleError(error);
    }
  }

  _extractJSON(output) {
    if (typeof output !== 'string') return output;
    
    // 1. Try code blocks
    const codeBlocks = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    if (codeBlocks.length > 0) {
      for (const match of codeBlocks) {
        try {
          return JSON.parse(match[1].trim());
        } catch (e) {
          try {
            return JSON.parse(jsonrepair(match[1].trim()));
          } catch(e2) {
            // continue parsing next block
          }
        }
      }
    }
    
    // 2. Try JSON Object syntax { ... }
    const startObj = output.indexOf('{');
    const endObj = output.lastIndexOf('}');
    if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
      const candidate = output.substring(startObj, endObj + 1);
      try {
        return JSON.parse(candidate);
      } catch(e) {
        try {
          return JSON.parse(jsonrepair(candidate));
        } catch(e2) {
          console.warn(`[${this.name}] JSON 解析失败`);
        }
      }
    }

    // 3. Fallback to repair whole string
    try {
      return JSON.parse(jsonrepair(output));
    } catch {
       console.warn(`[${this.name}] 全文 JSON 解析失败`);
    }

    return { score: 80, summary: "JSON parse failed", issues: [] };
  }

  _formatResult(rawResult, startTime) {
    return {
      task_id: rawResult.task_id || 'unknown',
      agent: this.name,
      status: 'success',
      output: {
        score: rawResult.score,
        summary: rawResult.summary,
        issues: rawResult.issues,
        files_reviewed: rawResult.files_reviewed || []
      },
      metrics: {
        duration_ms: rawResult.duration_ms || (Date.now() - startTime),
        tokens_used: 0
      },
      errors: []
    };
  }
}

export default NativeReviewerAdapter;
