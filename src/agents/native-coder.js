/**
 * Native Coder Adapter - AI 编程 Agent
 * 
 * 集成 UniversalToolbox，支持：
 * - 文件读写工具
 * - Bash 命令执行
 * - Git 操作
 * - LSP 代码分析
 * - 包管理器
 */

import { AgentAdapter } from './base.js';

const NATIVE_CODER_CONFIG = {
  name: 'native-coder',
  type: 'api',
  capabilities: ['coding', 'refactoring', 'file-editing', 'testing', 'git-operations']
};

export class NativeCoderAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...NATIVE_CODER_CONFIG, ...config });
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
      file: tools.filter(t => t.category === 'file_system').slice(0, 6),
      bash: tools.filter(t => t.category === 'bash').slice(0, 4),
      git: tools.filter(t => t.category === 'git'),
      package: tools.filter(t => t.category === 'package_manager')
    };

    let desc = '';
    
    if (categories.file.length) {
      desc += '\n【文件操作工具】\n';
      categories.file.forEach(t => {
        desc += `- ${t.name}: ${t.description}\n`;
      });
    }
    
    if (categories.bash.length) {
      desc += '\n【命令执行工具】\n';
      categories.bash.forEach(t => {
        desc += `- ${t.name}: ${t.description}\n`;
      });
    }
    
    if (categories.git.length) {
      desc += '\n【Git 工具】\n';
      categories.git.forEach(t => {
        desc += `- ${t.name}: ${t.description}\n`;
      });
    }
    
    if (categories.package.length) {
      desc += '\n【包管理工具】\n';
      categories.package.forEach(t => {
        desc += `- ${t.name}: ${t.description}\n`;
      });
    }
    
    return desc;
  }

  /**
   * 使用工具执行文件操作
   * @private
   */
  async _executeFileOperations(fileOps) {
    const results = [];
    for (const op of fileOps) {
      let result;
      switch (op.action) {
        case 'create':
        case 'write':
        case 'modify':
          result = await this.executeTool('write_file', {
            file_path: op.path,
            content: op.content,
            append: false
          });
          break;
        case 'delete':
          result = await this.executeTool('delete_file', {
            path: op.path,
            recursive: op.recursive || false
          });
          break;
        case 'read':
          result = await this.executeTool('read_file', {
            file_path: op.path
          });
          break;
        default:
          result = { success: false, error: `Unknown action: ${op.action}` };
      }
      results.push({ path: op.path, action: op.action, result });
    }
    return results;
  }

  /**
   * 获取项目上下文
   * @private
   */
  async _getProjectContext(projectRoot) {
    const context = { files: [], structure: '', techStack: '' };
    
    const listResult = await this.executeTool('list_directory', {
      dir_path: projectRoot || '.',
      include_hidden: false
    });
    
    if (listResult.success && listResult.result.items) {
      context.files = listResult.result.items
        .filter(i => i.type === 'file')
        .map(f => f.name);
      context.structure = listResult.result.items
        .map(i => `${i.type === 'directory' ? '📁' : '📄'} ${i.name}`)
        .join('\n');
    }
    
    const packageResult = await this.executeTool('read_file', { file_path: 'package.json' });
    if (packageResult.success) {
      try {
        const pkg = JSON.parse(packageResult.result.content);
        context.techStack = `Node.js/${pkg.engines?.node || 'unknown'} | ${Object.keys(pkg.dependencies || {}).slice(0, 5).join(', ')}`;
      } catch {}
    }
    
    const readmeResult = await this.executeTool('read_file', { file_path: 'README.md' });
    if (readmeResult.success) {
      context.readmeSummary = readmeResult.result.content.substring(0, 300);
    }
    
    const gitResult = await this.executeTool('git_status', {});
    if (gitResult.success) {
      context.gitStatus = gitResult.result.stdout?.substring(0, 200) || 'Clean';
    }
    
    return context;
  }

  async execute(task) {
    const startTime = Date.now();
    try {
      if (!this.apiKey) {
        throw new Error('API Key missing. Please set OPENAI_API_KEY or MINIMAX_API_KEY for native-coder');
      }

      const projectRoot = task.context?.project_root || '.';
      const projectContext = await this._getProjectContext(projectRoot);
      const toolsDescription = this._getToolsDescription();

      const systemPrompt = `你是一个资深的 AI 全栈工程师，负责根据需求编写高质量代码。
你工作在全自动环境，输出的代码必须能通过严格的代码审查（评审阈值 85 分）。

## 可用工具
你可以使用以下工具来完成代码编写任务：

${toolsDescription}

## 重要原则
1. 错误处理 - 所有可能失败的操作必须 try-catch，错误要记录和报告
2. 输入验证 - 验证所有外部输入，不信任任何用户数据
3. 安全性 - 防止 XSS、SQL 注入、命令注入等安全漏洞
4. 代码可读性 - 使用有意义的变量名，添加必要注释
5. 完整性 - 不要留 TODO，确保功能完整可运行
6. 工具优先 - 优先使用上述工具进行文件操作，而不是直接输出代码

## 输出格式要求
当需要使用工具时，请返回以下 JSON 格式的 tool_calls：
{
  "tool_calls": [
    {
      "tool": "write_file",
      "args": { "file_path": "src/index.js", "content": "..." }
    }
  ],
  "summary": "简短的一句话描述你做了什么"
}

要求：
- path 必须是基于项目根目录的相对路径
- 如果需要修改多个文件，请在 tool_calls 数组中放置多个对象
- 代码必须完整可运行，不要省略任何部分
- 不要包含 TODO、console.log、debugger 等调试代码
- 必须包含适当的错误处理和日志记录

不包含任何 Markdown 代码块标签(\`\`\`json)或额外说明！必须是可直接反序列化的纯 JSON。`;

      const userPrompt = `## 项目需求
${task.description}

## 项目结构
${projectContext.structure || '空目录'}

## 现有文件
${projectContext.files.join(', ') || '无'}

${projectContext.techStack ? `## 技术栈\n${projectContext.techStack}` : ''}
${projectContext.gitStatus ? `## Git 状态\n${projectContext.gitStatus}` : ''}
${projectContext.readmeSummary ? `## README 摘要\n${projectContext.readmeSummary}` : ''}

请使用工具完成代码编写任务，直接输出 JSON 格式的 tool_calls。`;

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
      const resultObj = this._extractJSON(contentStr);

      const filesCreated = [];
      const filesModified = [];

      if (resultObj.tool_calls && Array.isArray(resultObj.tool_calls) && projectRoot) {
        for (const toolCall of resultObj.tool_calls) {
          const { tool, args } = toolCall;
          
          if (tool === 'write_file' || tool === 'edit_file') {
            const fileOpResult = await this.executeTool(tool, args);
            if (fileOpResult.success) {
              const filePath = args.file_path;
              if (filePath) {
                filesCreated.push(filePath);
              }
              console.log(`[${this.name}] 已保存文件: ${filePath}`);
            }
          } else if (tool === 'bash_execute' || tool === 'npm_run' || tool === 'npm_install') {
            const cmdResult = await this.executeTool(tool, args);
            console.log(`[${this.name}] 命令执行: ${tool}`, cmdResult.success ? '✓' : '✗');
          }
        }
      }

      return this._formatResult({
        task_id: task.id,
        success: true,
        summary: resultObj.summary || '代码已生成并写入系统。',
        files_created: filesCreated,
        files_modified: filesModified,
        tool_calls_executed: resultObj.tool_calls?.length || 0,
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
          console.warn(`[${this.name}] JSON 解析失败，尝试降级处理`);
        }
    }
    return { summary: "JSON parse failed, raw output captured.", tool_calls: [] };
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
        summary: rawResult.summary || '',
        tool_calls_executed: rawResult.tool_calls_executed || 0
      },
      metrics: {
        duration_ms: rawResult.duration_ms || (Date.now() - startTime),
        tokens_used: 0
      },
      errors: rawResult.errors || []
    };
  }
}

export default NativeCoderAdapter;
