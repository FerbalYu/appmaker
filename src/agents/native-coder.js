import fs from 'fs';
import path from 'path';
import { AgentAdapter } from './base.js';

const NATIVE_CODER_CONFIG = {
  name: 'native-coder',
  type: 'api',
  capabilities: ['coding', 'refactoring', 'file-editing']
};

export class NativeCoderAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...NATIVE_CODER_CONFIG, ...config });
    // 支持 OpenAI, Deepseek, 也可以用 Minimax 通用接口
    this.apiKey = process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY || config.api_key;
    this.apiHost = process.env.OPENAI_API_BASE || process.env.MINIMAX_API_HOST || config.api_host || 'https://api.minimaxi.com';
    this.model = process.env.OPENAI_MODEL || process.env.MINIMAX_API_MODEL || config.model || 'MiniMax-Text-01'; // 默认 Text 模型
  }

  async healthCheck() {
    return !!this.apiKey;
  }

  async execute(task) {
    const startTime = Date.now();
    try {
      if (!this.apiKey) {
         throw new Error('API Key missing. Please set OPENAI_API_KEY or MINIMAX_API_KEY for native-coder');
      }

      const systemPrompt = `你是一个资深的 AI 全栈工程师，负责根据需求编写代码。
目前你工作在全自动环境，必须输出一段严格符合要求的纯 JSON。
不包含任何 Markdown 代码块标签(\`\`\`json)或额外说明！必须是可直接反序列化的内容。

输出格式要求：
{
  "summary": "简短的一句话描述你做了什么",
  "files": [
    {
      "action": "create",
      "path": "src/index.js",
      "content": "完整的代码内容..."
    }
  ]
}
附注：path 必须是基于项目根目录的相对路径。如果你需要修改多个文件，请在 files 数组中放置多个对象。
不要忽略必要的前端结构或依赖逻辑。`;

      // 提取项目根目录（如果存在）增强上下文
      let contextStr = "空目录";
      if (task.context && task.context.project_root) {
        try {
          const files = fs.readdirSync(task.context.project_root).filter(f => !f.startsWith('.'));
          contextStr = `当前项目一级目录有: ${files.join(', ')}`;
        } catch(e) {}
      }

      const userPrompt = `项目需求: ${task.description}\n${contextStr}\n\n请直接输出JSON内容完成代码编写任务：`;

      const endpoint = this.apiHost.endsWith('/v1') 
          ? `${this.apiHost}/chat/completions` 
          : `${this.apiHost}/v1/chat/completions`;

      console.log(`[${this.name}] 请求原生 API 进行编程任务... (Model: ${this.model})`);

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
          temperature: 0.1
        }),
        signal: AbortSignal.timeout(200000)
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`API Error ${res.status}: ${errorText}`);
      }

      const data = await res.json();
      
      if (!data.choices || data.choices.length === 0) {
        throw new Error(`API 响应结构异常: ${JSON.stringify(data).substring(0,200)}`);
      }
      
      const contentStr = data.choices[0].message.content;

      // 解析生成结果并写文件
      const resultObj = this._extractJSON(contentStr);

      const filesCreated = [];
      const filesModified = [];

      if (resultObj.files && Array.isArray(resultObj.files) && task.context?.project_root) {
         for (const fileObj of resultObj.files) {
           if (!fileObj.path || !fileObj.content) continue;
           
           const fullPath = path.join(task.context.project_root, fileObj.path);
           const dirPath = path.dirname(fullPath);
           if (!fs.existsSync(dirPath)) {
               fs.mkdirSync(dirPath, { recursive: true });
           }
           let existing = fs.existsSync(fullPath);
           fs.writeFileSync(fullPath, fileObj.content, 'utf-8');
           
           if (existing || fileObj.action === 'modify') {
               filesModified.push(fileObj.path);
           } else {
               filesCreated.push(fileObj.path);
           }
           console.log(`[${this.name}] 已保存文件: ${fileObj.path}`);
         }
      }

      return this._formatResult({
        task_id: task.id,
        success: true,
        summary: resultObj.summary || '代码已生成并写入系统。',
        files_created: filesCreated,
        files_modified: filesModified,
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
        } catch(e) {}
    }
    return { summary: "JSON parse failed, raw output captured.", files: [] };
  }

  _formatResult(rawResult, startTime) {
    return {
      task_id: rawResult.task_id || 'unknown',
      agent: this.name,
      status: rawResult.success ? 'success' : 'failed',
      output: {
        files_created: rawResult.files_created || [],
        files_modified: rawResult.files_modified || [],
        tests_run: false,
        summary: rawResult.summary || ''
      },
      metrics: {
        duration_ms: rawResult.duration_ms || (Date.now() - startTime),
        tokens_used: 0
      },
      errors: rawResult.errors || []
    };
  }
}
