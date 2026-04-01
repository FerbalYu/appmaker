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
import { jsonrepair } from 'jsonrepair';
import { promises as fs } from 'fs';
import path from 'path';

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
   * 获取原生工具定义 Schema
   * @private
   */
  _getNativeToolsSchema() {
    const tools = this.getTools();
    const fileTools = tools.filter(t => t.category === 'file_system').slice(0, 6);
    const bashTools = tools.filter(t => t.category === 'bash').slice(0, 4);
    const gitTools = tools.filter(t => t.category === 'git');
    const pkgTools = tools.filter(t => t.category === 'package_manager');
    
    const filteredTools = [...fileTools, ...bashTools, ...gitTools, ...pkgTools];
    
    return filteredTools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema
      }
    }));
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
      const toolsSchema = this._getNativeToolsSchema();

      const systemPrompt = `你是一个资深的 AI 全栈工程师，负责根据需求编写高质量代码。
你工作在全自动环境，输出的代码必须能通过严格的代码审查（评审阈值 85 分）。

## 重要原则
1. 错误处理 - 所有可能失败的操作必须 try-catch，错误要记录和报告
2. 输入验证 - 验证所有外部输入，不信任任何用户数据
3. 安全性 - 防止 XSS、SQL 注入、命令注入等安全漏洞
4. 代码可读性 - 使用有意义的变量名，添加必要注释
5. 完整性 - 不要留 TODO，确保功能完整可运行
6. 严禁 Bash 穿透写文件 - 当你要创建或更改代码、文档时，**必须且只能使用 \`write_file\` 或 \`edit_file\` 工具**。绝对禁止使用 \`bash_execute\` 执行 echo/cat 等命令输出文件，否则系统判定为你严重失职！

你已经接入了全自动开发动作执行平台，当你需要读取/修改文件、执行命令时，请直接主动调用工具 (Tools)。请尽可能结合当前上下文环境做出符合项目技术栈的直接干预和修改！`;

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

      let messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      let finalContent = '代码编写完毕。';
      let executedCount = 0;
      let totalTokens = 0;

      for (let step = 0; step < 15; step++) {
        const payload = {
          model: this.model,
          messages,
          tools: toolsSchema,
          temperature: 0.1
        };
        
        // Support for Minimax Native Reasoning Split
        // This prevents <think> tags from disrupting tool calls or content text
        if (this.apiHost.includes('minimaxi.com')) {
          payload.extra_body = { reasoning_split: true };
        }

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(600000)
        });

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`API Error ${res.status}: ${errorText}`);
        }

        const data = await res.json();
        totalTokens += data.usage?.total_tokens || 0;
        
        if (!data.choices || data.choices.length === 0) {
          throw new Error(`API 响应结构异常: ${JSON.stringify(data).substring(0,200)}`);
        }
        
        const message = data.choices[0].message;
        
        // Emit Reasoning Process as Telemetry
        if (message.reasoning_details && message.reasoning_details.length > 0) {
          const reasoningText = message.reasoning_details.map(r => r.text).join('\n');
          if (typeof this.emit === 'function') {
            this.emit('action', { type: 'think', content: reasoningText.trim() });
          }
        } else {
          // Fallback for non-Minimax models or if reasoning_split is not supported
          const contentStr = message.content || "";
          const thinkMatch = contentStr.match(/<think>([\s\S]*?)<\/think>/i);
          if (thinkMatch && typeof this.emit === 'function') {
             this.emit('action', { type: 'think', content: thinkMatch[1].trim() });
          }
        }
        
        messages.push(message);

        const nativeToolCalls = message.tool_calls || [];

        if (nativeToolCalls.length === 0) {
          if (step === 0) {
            this._log && this._log('INFO', `[${this.name}] ⚠️ 未检测到原生的 tool_calls。模型回复: ${message.content?.substring(0, 100)}...`);
          }
          finalContent = message.content || finalContent;
          break; // 跳出大循环
        }

        if (nativeToolCalls.length > 0 && projectRoot) {
          for (const toolCall of nativeToolCalls) {
            executedCount++;
            const tool = toolCall.function.name;
            let args = {};
            try {
              args = JSON.parse(toolCall.function.arguments);
            } catch (e) {
              console.error(`[${this.name}] 解析工具调用参数失败，尝试 repair:`, toolCall.function.arguments);
              try {
                args = JSON.parse(jsonrepair(toolCall.function.arguments));
              } catch (e2) {
                console.error(`[${this.name}] Repair 解析再次失败，跳过`);
                messages.push({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: JSON.stringify({ success: false, error: 'Invalid arguments format JSON parse error' })
                });
                continue;
              }
            }
            
            let toolResultObj;
            if (tool === 'write_file' || tool === 'edit_file') {
              const fileOpResult = await this.executeTool(tool, args);
              toolResultObj = fileOpResult;
              if (fileOpResult.success) {
                console.log(`[${this.name}] 已保存文件: ${args.file_path}`);
              }
            } else if (tool === 'bash_execute' || tool === 'npm_run' || tool === 'npm_install') {
              const cmdResult = await this.executeTool(tool, args);
              toolResultObj = cmdResult;
              console.log(`[${this.name}] 命令执行: ${tool}`, cmdResult.success ? '✓' : '✗');
            } else {
              toolResultObj = await this.executeTool(tool, args);
            }

            let textOutput = typeof toolResultObj === 'string' ? toolResultObj : JSON.stringify(toolResultObj);
            if (textOutput.length > 8000) {
              textOutput = textOutput.substring(0, 8000) + '... (output truncated due to length)';
            }
            
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: textOutput
            });
          }
        }
      }

      const { created: filesCreated, modified: filesModified } = await this._detectFileChanges(projectRoot, startTime);

      return this._formatResult({
        task_id: task.id,
        success: true,
        summary: finalContent,
        files_created: filesCreated,
        files_modified: filesModified,
        tool_calls_executed: executedCount,
        tokens_used: totalTokens,
        duration_ms: Date.now() - startTime
      }, startTime);

    } catch (error) {
      console.error(`[${this.name}] 执行异常: `, error.message);
      return this.handleError(error);
    }
  }

  async _detectFileChanges(dir, startTime) {
    const changes = { created: [], modified: [] };
    const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.appmaker', '.daemon'];
    
    const scan = async (currentDir) => {
      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
           if (entry.isDirectory() && ignoreDirs.includes(entry.name)) continue;
           const fullPath = path.join(currentDir, entry.name);
           if (entry.isDirectory()) {
             await scan(fullPath);
           } else {
             const stat = await fs.stat(fullPath);
             // 允许 1000ms 时间差容错
             if (stat.mtimeMs >= startTime - 1000) {
                const relPath = path.relative(dir, fullPath).replace(/\\/g, '/');
                if (stat.birthtimeMs >= startTime - 1000) {
                  changes.created.push(relPath);
                } else {
                  changes.modified.push(relPath);
                }
             }
           }
        }
      } catch (e) {
        // 忽略错误
      }
    };
    
    await scan(dir);
    return changes;
  }

  _extractJSON(output) {
    if (typeof output !== 'string') return output;
    
    // Capture <think> block and emit to telemetry before stripping
    const thinkMatch = output.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch && typeof this.emit === 'function') {
      this.emit('action', { type: 'think', content: thinkMatch[1].trim() });
    }
    
    // Strip <think>...</think> reasoning tags which corrupt JSON matching
    output = output.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    
    // 1. Try code blocks
    const codeBlocks = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    if (codeBlocks.length > 0) {
      for (const match of codeBlocks) {
        try {
          return JSON.parse(match[1].trim());
        } catch (e) {
          try {
            return JSON.parse(jsonrepair(match[1].trim()));
          } catch(e2) {}
        }
      }
    }
    
    // 2. Try JSON Object syntaxes through brace matching
    const braceCount = (output.match(/[{}]/g) || []).length;
    if (braceCount >= 2) {
      let depth = 0, validEnd = -1, firstBrace = output.indexOf('{');
      if (firstBrace !== -1) {
        for (let i = firstBrace; i < output.length; i++) {
          if (output[i] === '{') depth++;
          else if (output[i] === '}') {
            depth--;
            if (depth === 0) { validEnd = i; break; }
          }
        }
        if (validEnd > firstBrace) {
          const candidate = output.substring(firstBrace, validEnd + 1);
          try { return JSON.parse(candidate); } catch(e) {
            try { return JSON.parse(jsonrepair(candidate)); } catch {}
          }
        }
      }
    }

    // 3. Fallback to repair whole string
    try {
      return JSON.parse(jsonrepair(output));
    } catch {
       console.warn(`[${this.name}] 全文 JSON 解析失败`);
    }

    return null;
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
        tokens_used: rawResult.tokens_used || 0
      },
      errors: rawResult.errors || []
    };
  }
}

export default NativeCoderAdapter;
