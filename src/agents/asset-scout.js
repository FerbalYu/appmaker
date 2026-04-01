/**
 * AssetScout MCP Adapter
 * 结合 MiniMax 与 Playwright MCP 实现自适应寻找素材能力
 */

import { AgentAdapter } from './base.js';
import { jsonrepair } from 'jsonrepair';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const ASSET_SCOUT_CONFIG = {
  name: 'asset-scout',
  type: 'api',
  capabilities: [
    'web-browsing',
    'asset-gathering',
    'creative-adapting'
  ]
};

const SYSTEM_PROMPT = `你是一个名为 AssetScout 的首席美术资源侦查员（兼策划适应专家）。
你的目标是：根据被给予的粗略游戏需求，前往 https://kenney.nl/assets 寻找到最合适的开源 CC0 游戏素材。
你可以直接调用浏览器工具 (Playwright) 搜索并下载对应的 zip 素材包。

【工作流指导】
1. 分析需求中的核心元素（如 射击、外星人、丧尸、平台跳跃 等）。
2. 把合适的元素翻译成英文关键词（如 platformer, space, characters, UI）。
3. 使用 browser_navigate 前往 https://kenney.nl/assets。
4. 视情况使用 browser_click, browser_fill 等工具搜索关键词。浏览网页拿到你满意的素材包详情页或者是 zip 下载链接。如果找不到目标关键词对应的素材，请主动妥协寻找能平替的素材（如把丧尸替换为怪物）。
5. 获取到确切素材包详情或 zip 链接后，调用专属的原生本地工具 \`download_and_extract_zip\`，该工具会在后台处理下载并解压，并返回文件名列表给你。注意：不能直接使用浏览器工具点击下载按钮（无头模式可能被拦截或无法获取文件存放路径），必须使用 \`download_and_extract_zip\` 来获取文件。

【原生开发工具】：
- \`download_and_extract_zip\` : 传入你想下载的 url（直接指向 kenney 包下载链接或详情页），由后台下载解压到 \`public/assets\` 目录下，并返回实际的文件名列表。

【必须遵循的最终输出格式 JSON】:
完成素材搜集后，你必须整合出以下格式的 JSON 结果并返回（必须只有合法的 JSON）：
{
  "theme_adapted": "最终决定或妥协使用的游戏主题说明",
  "assets_found": ["文件1.png", "文件2.xml"],
  "advice": "给下一个环节（原画师/策划/程序）的适配建议"
}`;

export class AssetScoutAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...ASSET_SCOUT_CONFIG, ...config });
    this.apiKey = process.env.MINIMAX_API_KEY || config.api_key;
    this.apiHost = process.env.MINIMAX_API_HOST || config.api_host || 'https://api.minimaxi.com';
    this.model = process.env.MINIMAX_API_MODEL || config.model || 'MiniMax-M2.7';
  }

  async healthCheck() {
    return !!this.apiKey;
  }

  async _downloadAndExtractTool(url, projectRoot) {
    try {
      const assetsDir = path.join(projectRoot, 'public', 'assets', 'scout_' + Date.now());
      await fs.promises.mkdir(assetsDir, { recursive: true });
      
      const zipPath = path.join(assetsDir, 'temp.zip');
      
      // 注意: Kenney.nl 的包下载页可能比较特殊，直链可以 fetch。
      console.log(`[AssetScout] 页面/直链探测: ${url}`);
      const res = await fetch(url);
      const text = await res.text();
      
      let realZipUrl = url;
      if (!url.endsWith('.zip')) {
        const zipMatch = text.match(/href="([^"]+\.zip[^"]*)"/);
        if (zipMatch) {
            realZipUrl = zipMatch[1];
            if (!realZipUrl.startsWith('http')) {
                if(realZipUrl.startsWith('//')) {
                     realZipUrl = 'https:' + realZipUrl;
                } else {
                     realZipUrl = `https://kenney.nl${realZipUrl.startsWith('/')?'':'/'}${realZipUrl}`;
                }
            }
        }
      }

      console.log(`[AssetScout] 正在下载素材: ${realZipUrl}`);
      await execAsync(`curl -L -o "${zipPath}" "${realZipUrl}"`);
      
      console.log(`[AssetScout] 解压素材到: ${assetsDir}`);
      if (process.platform === 'win32') {
        await execAsync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${assetsDir}' -Force"`);
      } else {
        await execAsync(`unzip -o "${zipPath}" -d "${assetsDir}"`);
      }
      
      // 删除生成的临时 zip 以保持干净
      try { await fs.promises.unlink(zipPath); } catch (e) {}
      
      const getAllFiles = async (dir) => {
        let results = [];
        const list = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const file of list) {
          const filePath = path.join(dir, file.name);
          if (file.isDirectory()) {
            results = results.concat(await getAllFiles(filePath));
          } else {
            results.push(filePath);
          }
        }
        return results;
      };
      
      const allFiles = await getAllFiles(assetsDir);
      
      return JSON.stringify({
        success: true,
        saved_dir: assetsDir,
        files: allFiles
                 .filter(f => !f.endsWith('.txt') && !f.endsWith('.pdf'))
                 .map(f => path.relative(assetsDir, f))
                 .slice(0, 80) // 限制返回数量
      });
    } catch (err) {
      return JSON.stringify({ success: false, error: err.message });
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

      console.log(`[${this.name}] 初始化 Playwright MCP 代理环境...`);
      transport = new StdioClientTransport({
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest']
      });

      mcpClient = new Client(
        { name: 'appmaker-asset-scout', version: '1.0.0' },
        { capabilities: {} }
      );

      await mcpClient.connect(transport);
      console.log(`[${this.name}] Playwright MCP 服务连接完成，获取工具集...`);

      const toolsMetadata = await mcpClient.listTools();
      const tools = toolsMetadata.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema || { type: 'object', properties: {} }
        }
      }));

      // 添加自定义本地工具
      tools.push({
        type: 'function',
        function: {
          name: 'download_and_extract_zip',
          description: '下载 ZIP 素材并解压到 public/assets',
          parameters: {
            type: 'object',
            properties: {
              target_url: { type: 'string', description: '从网页获取的真实包详情页 URL 或 ZIP 直链' }
            },
            required: ['target_url']
          }
        }
      });

      let messages = [
        { role: 'system', name: 'system', content: SYSTEM_PROMPT },
        { role: 'user', name: 'user', content: task.description }
      ];

      let finalOutput = '';
      
      // 对话大循环，最多 12 次 tool calls (抓网页和探索可能较慢)
      for (let i = 0; i < 12; i++) {
        const payload = {
          model: this.model,
          messages,
          ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {})
        };
        
        if (this.apiHost.includes('minimaxi.com')) {
          payload.extra_body = { reasoning_split: true };
        }

        const res = await fetch(`${this.apiHost}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(600000)
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`MiniMax API error: ${res.status} ${errText}`);
        }

        const data = await res.json();
        
        if (data.base_resp && data.base_resp.status_code !== 0) {
          throw new Error(`MiniMax API Error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
        } else if (data.error) {
          throw new Error(`API Error ${data.error.code || data.error.type}: ${data.error.message}`);
        }

        if (!data?.choices || data.choices.length === 0) {
          break;
        }

        const choice = data.choices[0];
        const message = choice.message;

        // Emit Contextual Reasoning
        if (message.reasoning_details && message.reasoning_details.length > 0) {
          const reasoningText = message.reasoning_details.map(r => r.text).join('\n');
          if (typeof this.emit === 'function') this.emit('action', { type: 'think', content: reasoningText.trim() });
        } else {
          const contentStr = message.content || "";
          const thinkMatch = contentStr.match(/<think>([\s\S]*?)<\/think>/i);
          if (thinkMatch && typeof this.emit === 'function') {
             this.emit('action', { type: 'think', content: thinkMatch[1].trim() });
          }
        }
        
        messages.push(message);

        if (message.tool_calls?.length > 0) {
          console.log(`[${this.name}] 调用了 ${message.tool_calls.length} 个工具: ${message.tool_calls.map(t=>t.function.name).join(', ')}`);
          for (const toolCall of message.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments || '{}');
            let toolResult;
            
            try {
              if (toolCall.function.name === 'download_and_extract_zip') {
                const resStr = await this._downloadAndExtractTool(args.target_url, task.context?.project_root || process.cwd());
                toolResult = { content: [{ type: 'text', text: resStr }] };
              } else {
                toolResult = await mcpClient.callTool({ name: toolCall.function.name, arguments: args });
              }
            } catch (err) {
              toolResult = { content: [{ type: 'text', text: `Error: ${err.message}` }] };
            }

            let textOutput = typeof toolResult?.content?.[0]?.text === 'string' ? toolResult.content[0].text : JSON.stringify(toolResult);
            if (textOutput.length > 8000) {
              textOutput = textOutput.substring(0, 8000) + '... (output truncated due to length)';
            }
            messages.push({
              role: 'tool',
              name: toolCall.function.name,
              tool_call_id: toolCall.id,
              content: textOutput
            });
          }
        } else {
          finalOutput = message.content;
          break;
        }
      }

      if (!finalOutput && messages[messages.length - 1].content) {
        finalOutput = messages[messages.length - 1].content;
      }

      const contentStr = this._extractJSON(finalOutput);

      return this._formatResult({
        task_id: task.id,
        success: !!contentStr,
        output: contentStr,
        duration_ms: Date.now() - startTime
      }, startTime);

    } catch (error) {
      console.error(`[${this.name}] 执行失败: `, error.message);
      return this.handleError(error);
    } finally {
      if (mcpClient) {
        try { await mcpClient.close(); } catch { /* ignore */ }
      }
      if (transport) {
        try { await transport.close(); } catch { /* ignore */ }
      }
    }
  }

  _extractJSON(output) {
    if (typeof output !== 'string') return output;

    // Capture <think> block and emit to telemetry before stripping
    const thinkMatch = output.match(/<think>([\s\S]*?)<\/think>/i);
    if (thinkMatch && typeof this.emit === 'function') {
      this.emit('action', { type: 'think', content: thinkMatch[1].trim() });
    }

    output = output.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    const codeBlocks = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    for (const match of codeBlocks) {
      const extracted = match[1].trim();
      if (this._isValidJSON(extracted)) return this._repairIfNeeded(extracted);
    }

    const startObj = output.indexOf('{');
    const endObj = output.lastIndexOf('}');
    if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
      const candidate = output.substring(startObj, endObj + 1);
      if (this._isValidJSON(candidate)) return this._repairIfNeeded(candidate);
    }
    
    try {
      if (this._isValidJSON(output)) return this._repairIfNeeded(output);
    } catch {}

    return null;
  }

  _repairIfNeeded(str) {
      try {
          JSON.parse(str);
          return str;
      } catch {
          return jsonrepair(str);
      }
  }

  _isValidJSON(str) {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      try {
         JSON.parse(jsonrepair(trimmed));
         return true;
      } catch {
         return false;
      }
    }
  }

  _formatResult(rawResult, startTime) {
    const output = rawResult.output;
    return {
      task_id: rawResult.task_id || 'unknown',
      agent: this.name,
      status: output ? 'success' : 'failed',
      output: output || null,
      metrics: {
        duration_ms: rawResult.duration_ms || (Date.now() - startTime),
        tokens_used: 0
      },
      errors: output ? [] : ['Failed to properly gather assets or extract valid JSON']
    };
  }
}
