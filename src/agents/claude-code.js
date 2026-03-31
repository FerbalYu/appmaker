/**
 * Claude Code Adapter
 * 调用 Claude Code CLI 或 API 执行复杂推理和架构任务
 */

import { AgentAdapter } from './base.js';
import { ACPClient } from './acp-client.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

export class ClaudeCodeAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...CLAUDE_CODE_CONFIG, ...config });
    this.cliPath = config.cli_path || 'claude';
    this.apiEndpoint = config.api_endpoint || 'http://localhost:8080';
    this.timeout = config.timeout || 120000;
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
    const prompt = this._buildPrompt(task);
    const { context = {} } = task;

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
    const acpBridgePath = path.join(__dirname, 'acp-bridges', 'claude-bridge.js');
    console.log(`[claude-code] Starting ACP Bridge at: ${acpBridgePath}`);

    // 使用 Bun 执行路径
    const bunPath = process.execPath;
    console.log(`[claude-code] Using bun: ${bunPath}`);

    const client = new ACPClient(bunPath, [acpBridgePath], {
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
      await client.start(30000);
      console.log('[claude-code] ACP Bridge started, sending execute...');
      const result = await client.request('execute', { prompt, context, timeout: this.timeout }, this.timeout + 5000);
      console.log('[claude-code] Execute completed!');
      return result;
    } finally {
      client.stop();
    }
  }

  /**
   * 通过 API 执行（使用 fetch 替代 http 模块）
   * @private
   */
  async _executeViaAPI(prompt, context) {
    const response = await fetch(this.apiEndpoint + '/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
      }),
      signal: AbortSignal.timeout(this.timeout)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error: ${response.status} ${text}`);
    }
    return response.json();
  }

  /**
   * 构建 prompt
   * @private
   */
  _buildPrompt(task) {
    let prompt = `任务：${task.description}\n\n请直接执行任务，不要询问确认。`;

    if (task.files?.length > 0) {
      prompt += `\n\n相关文件：${task.files.join(', ')}`;
    }

    prompt += `\n\n## 输出要求\n请以 JSON 格式返回，包含：files_created（数组）, files_modified（数组）, summary（字符串总结）, tests_run（布尔值）`;

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
        const acpBridgePath = path.join(__dirname, 'acp-bridges', 'claude-bridge.js');
        const client = new ACPClient(process.execPath, [acpBridgePath], {}, 'claude-acp-hc');
        try {
          await client.start(5000);
          return true;
        } finally {
          client.stop();
        }
      } else {
        const res = await fetch(this.apiEndpoint + '/health', {
          signal: AbortSignal.timeout(5000)
        });
        return res.ok;
      }
    } catch {
      return false;
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
