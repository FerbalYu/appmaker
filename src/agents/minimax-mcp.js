/**
 * Minimax Token Plan MCP Adapter
 * 结合 MiniMax-M2.7 与 MCP (uvx minimax-coding-plan-mcp) 
 * 为 Planner 赋能搜商，生成更落地的架构计划
 */

const { AgentAdapter } = require('./base');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const axios = require('axios');

const MINIMAX_MCP_CONFIG = {
  name: 'minimax-mcp',
  type: 'api',
  capabilities: [
    'complex-reasoning',
    'web-search',
    'image-understanding',
    'architecture-design'
  ]
};

const SYSTEM_PROMPT = `你是一个资深的软件架构师。请深入分析以下项目需求，你可以使用工具通过网络搜集更多资料（比如遇到不熟悉的框架、最新技术栈时），然后再严格输出一个 JSON 格式的任务分解计划。
不要包含任何除了 JSON 外的其他多余 Markdown 或闲聊文字。此输出将直接被程序解析。

# 必须遵循的输出格式:
{
  "project": { "name": "项目英文短名称", "description": "一句话核心介绍" },
  "features": ["特性1", "特性2", "特性3"],
  "tasks": [
    {
      "id": "t1",
      "description": "具体的开发阶段或实现任务",
      "type": "architect", // 可选值: architect, create, integrate, test 等
      "dependencies": [], // 此任务依赖的前置任务 id 列表
      "agent": "claude-code",
      "estimated_tokens": 2000,
      "estimated_minutes": 15
    }
  ],
  "milestones": [
    { "id": "m1", "name": "基础框架阶段", "tasks": ["t1", "t2"] }
  ]
}`;

class MinimaxMCPAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...MINIMAX_MCP_CONFIG, ...config });
    this.apiKey = process.env.MINIMAX_API_KEY || config.api_key;
    this.apiHost = process.env.MINIMAX_API_HOST || config.api_host || 'https://api.minimaxi.com';
    this.model =  process.env.MINIMAX_API_MODEL || config.model || 'MiniMax-M2.7';
    this.mcpCommand = process.env.MINIMAX_MCP_COMMAND || config.mcp_command || 'uvx';
    this.mcpArgs = process.env.MINIMAX_MCP_ARGS || config.mcp_args || ['minimax-coding-plan-mcp', '-y'];
  }

  async healthCheck() {
    if (!this.apiKey) return false;
    try {
      const res = await axios.post(`${this.apiHost}/v1/text/chatcompletion_pro`, {
        model: this.model,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 10
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async execute(task) {
    const startTime = Date.now();
    let mcpClient = null;
    let transport = null;

    try {
      if (!this.apiKey) {
        throw new Error('MINIMAX_API_KEY environment variable is missing.');
      }

      console.log(`[${this.name}] 初始化 MCP 客户端: ${this.mcpCommand} ${this.mcpArgs.join(' ')}`);
      transport = new StdioClientTransport({
        command: this.mcpCommand,
        args: this.mcpArgs,
        env: {
          ...process.env,
          MINIMAX_API_KEY: this.apiKey, // 将 key 传给 MCP
          MINIMAX_API_HOST: this.apiHost
        }
      });

      mcpClient = new Client(
        { name: 'appmaker-minimax-planner', version: '1.0.0' },
        { capabilities: {} }
      );

      await mcpClient.connect(transport);
      console.log(`[${this.name}] MCP 服务已连接，获取工具列表...`);
      
      const toolsMetadata = await mcpClient.listTools();
      const tools = toolsMetadata.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema || { type: 'object', properties: {} }
        }
      }));

      // 构建对话循环
      let messages = [
        { role: 'system', name: 'system', content: SYSTEM_PROMPT },
        { role: 'user', name: 'user', content: task.description }
      ];

      let finalOutput = '';

      // 对话大循环，最多支持 5 次 tool calls
      for (let i = 0; i < 5; i++) {
        const reqPayload = {
          model: this.model,
          messages: messages,
          tools: tools,
          tool_choice: "auto"
        };

        const res = await axios.post(`${this.apiHost}/v1/text/chatcompletion_pro`, reqPayload, {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        });

        const choice = res.data.choices[0];
        const message = choice.message;
        
        // 追加模型的原始响应到历史中
        messages.push(message);

        if (message.tool_calls && message.tool_calls.length > 0) {
          console.log(`[${this.name}] 模型尝试调用 ${message.tool_calls.length} 个工具...`);
          for (const toolCall of message.tool_calls) {
            console.log(`[${this.name}] 调用工具: ${toolCall.function.name}`);
            const args = JSON.parse(toolCall.function.arguments);
            let toolResult;
            try {
              toolResult = await mcpClient.callTool({
                name: toolCall.function.name,
                arguments: args
              });
            } catch (err) {
              toolResult = { content: [{ type: 'text', text: `Error: ${err.message}`}] };
            }
            
            // 将工具返回结果加入对话
            let textOutput = '';
            if (toolResult.content && toolResult.content.length > 0) {
              textOutput = toolResult.content[0].text;
            } else {
              textOutput = JSON.stringify(toolResult);
            }

            messages.push({
              role: 'tool',
              name: toolCall.function.name,
              tool_call_id: toolCall.id,
              content: textOutput
            });
          }
        } else {
          // 没有工具调用，模型给出了最终结论
          finalOutput = message.content;
          break;
        }
      }

      // 如果 5 轮都没有给出最终输出，兜底处理
      if (!finalOutput && messages[messages.length - 1].content) {
        finalOutput = messages[messages.length - 1].content;
      }

      // 尝试校验输出 JSON
      const contentStr = this._extractJSON(finalOutput);

      return this._formatResult({
        task_id: task.id,
        success: true,
        output: contentStr,
        duration_ms: Date.now() - startTime
      }, startTime);

    } catch (error) {
       console.error(`[${this.name}] 执行失败: `, error.message);
       if (error.response?.data) {
         console.error('API Response details:', error.response.data);
       }
       return this.handleError(error);
    } finally {
      if (mcpClient) {
         try {
           await mcpClient.close();
         } catch(e) {}
      }
      if (transport) {
         try {
           await transport.close();
         } catch(e) {}
      }
    }
  }

  _extractJSON(output) {
    if (typeof output !== 'string') return output;
    
    // 提取 markdown 中的 json
    const codeBlocks = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    for (const match of codeBlocks) {
      return match[1].trim();
    }
    
    // 备用提取
    const startObj = output.indexOf('{');
    const endObj = output.lastIndexOf('}');
    if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
      return output.substring(startObj, endObj + 1);
    }
    
    return output;
  }

  _formatResult(rawResult, startTime) {
    return {
      task_id: rawResult.task_id || 'unknown',
      agent: this.name,
      status: rawResult.success ? 'success' : 'failed',
      output: {
        files_created: [],
        files_modified: [],
        tests_run: false,
        summary: rawResult.output
      },
      metrics: {
        duration_ms: rawResult.duration_ms || (Date.now() - startTime),
        tokens_used: 0
      },
      errors: rawResult.errors || []
    };
  }
}

module.exports = { MinimaxMCPAdapter };
