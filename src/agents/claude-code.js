/**
 * Claude Code Adapter
 * 调用 Claude Code CLI 或 API 执行复杂推理和架构任务
 */

const { AgentAdapter } = require('./base');

const CLAUDE_CODE_CONFIG = {
  name: 'claude-code',
  type: 'cli-api',
  capabilities: [
    'complex-reasoning',
    'architecture-design',
    'deep-analysis',
    'multi-module-coordination',
    'context-heavy-tasks'
  ]
};

class ClaudeCodeAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...CLAUDE_CODE_CONFIG, ...config });
    this.cliPath = config.cli_path || 'claude';
    this.apiEndpoint = config.api_endpoint || 'http://localhost:8080';
    this.timeout = config.timeout || 120000; // 120 秒
    this.maxRetries = config.max_retries || 3;
    this.model = config.model || 'claude-opus-4-6';
  }

  /**
   * 执行 claude-code 任务
   * @param {Object} task
   * @returns {Promise<Object>}
   */
  async execute(task) {
    const startTime = Date.now();
    let lastError;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this._executeOnce(task);
        return this._formatResult(result, startTime);
      } catch (error) {
        lastError = error;
        console.error(`[claude-code] Attempt ${attempt} failed:`, error.message);
        if (attempt < this.maxRetries) {
          await this._delay(2000 * attempt);
        }
      }
    }

    return this.handleError(lastError);
  }

  /**
   * 实际执行（单次）
   * @private
   */
  async _executeOnce(task) {
    const { id, description, files = [], context = {} } = task;

    const prompt = this._buildPrompt(task);

    if (this.config.use_cli) {
      return this._executeViaCLI(prompt, context);
    } else {
      return this._executeViaAPI(prompt, context);
    }
  }

  /**
   * 通过 CLI (ACP) 执行
   * @private
   */
  async _executeViaCLI(prompt, context) {
    const { ACPClient } = require('./acp-client');
    const path = require('path');

    const acpBridgePath = path.join(__dirname, 'acp-bridges', 'claude-bridge.js');
    console.log(`[claude-code] Starting ACP Bridge at: ${acpBridgePath}`);

    // 使用完整路径避免空格问题
    const nodePath = process.execPath;
    console.log(`[claude-code] Using node: ${nodePath}`);

    const client = new ACPClient(nodePath, [acpBridgePath], {
       cwd: context.project_root || process.cwd()
    }, 'claude-acp');

    client.on('stderr', (data) => {
       process.stderr.write(`[claude-acp err] ${data}`);
    });

    client.on('notification', (msg) => {
       if (msg.method === 'agent/stderr') {
         process.stderr.write(`[claude-acp remote stderr] ${msg.params.data}`);
       }
    });

    try {
      console.log('[claude-code] Waiting for ACP Bridge to start...');
      await client.start(30000); // 30秒启动超时
      console.log('[claude-code] ACP Bridge started, sending execute...');
      const result = await client.request('execute', { prompt, context, timeout: this.timeout }, this.timeout + 5000);
      console.log('[claude-code] Execute completed!');
      return result;
    } finally {
      client.stop();
    }
  }

  /**
   * 通过 API 执行
   * @private
   */
  async _executeViaAPI(prompt, context) {
    const http = require('http');

    const requestBody = JSON.stringify({
      prompt,
      model: this.model,
      context: {
        ...context,
        task_id: context.task_id,
        project_root: context.project_root,
        checkpoint: context.checkpoint
      },
      options: {
        timeout: this.timeout,
        noninteractive: true
      }
    });

    return new Promise((resolve, reject) => {
      const url = new URL(this.apiEndpoint + '/execute');
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`API error: ${res.statusCode} ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid API response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });
  }

  /**
   * 构建 prompt
   * @private
   */
  _buildPrompt(task) {
    let prompt = `任务：${task.description}\n\n请直接执行任务，不要询问确认。`;

    if (task.files && task.files.length > 0) {
      prompt += `\n\n相关文件：${task.files.map(f => `${f}`).join(', ')}`;
    }

    prompt += `\n\n## 输出要求
请以 JSON 格式返回，包含：files_created（数组）, files_modified（数组）, summary（字符串总结）, tests_run（布尔值）`;

    return prompt;
  }

  /**
   * 格式化结果
   * @private
   */
  _formatResult(rawResult, startTime) {
    const duration = Date.now() - startTime;

    return {
      task_id: rawResult.task_id || 'unknown',
      agent: this.name,
      status: rawResult.success !== false ? 'success' : 'failed',
      output: {
        files_created: rawResult.files_created || [],
        files_modified: rawResult.files_modified || [],
        tests_run: rawResult.tests_run || false,
        summary: rawResult.summary || rawResult.output || ''
      },
      metrics: {
        duration_ms: rawResult.duration_ms || duration,
        tokens_used: rawResult.tokens_used || 0
      },
      errors: rawResult.errors || []
    };
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      if (this.config.use_cli) {
        const { ACPClient } = require('./acp-client');
        const path = require('path');
        const acpBridgePath = path.join(__dirname, 'acp-bridges', 'claude-bridge.js');
        const client = new ACPClient(process.execPath, [acpBridgePath], {}, 'claude-acp-hc');
        try {
           await client.start(5000);
           return true;
        } finally {
           client.stop();
        }
      } else {
        const http = require('http');
        return new Promise((resolve) => {
          const req = http.get(this.apiEndpoint + '/health', (res) => {
            resolve(res.statusCode === 200);
          });
          req.on('error', () => resolve(false));
          req.setTimeout(5000, () => {
            req.destroy();
            resolve(false);
          });
        });
      }
    } catch {
      return false;
    }
  }

  /**
   * 延迟
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { ClaudeCodeAdapter };
