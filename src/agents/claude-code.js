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
    this.timeout = config.timeout || 300000; // 5 分钟
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
   * 通过 CLI 执行
   * @private
   */
  async _executeViaCLI(prompt, context) {
    const { spawn } = require('child_process');

    const args = [
      '--print',
      prompt
    ];

    if (context.project_root) {
      args.push('--project', context.project_root);
    }

    if (context.checkpoint) {
      args.push('--checkpoint', context.checkpoint);
    }

    // 对于长时间运行的任务，使用 --noninteractive
    if (context.noninteractive !== false) {
      args.push('--noninteractive');
    }

    return new Promise((resolve, reject) => {
      // 绕过嵌套检查：在 Claude Code 内运行时需要
      const child = spawn(this.cliPath, args, {
        timeout: this.timeout,
        shell: true,
        env: { ...process.env, CLAUDECODE: '' }
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`claude-code exited with code ${code}\nStderr: ${stderr}`));
          return;
        }

        try {
          // 尝试解析多行 JSON
          const lines = stdout.trim().split('\n');
          const jsonLines = lines.filter(l => {
            try {
              JSON.parse(l);
              return true;
            } catch {
              return false;
            }
          });

          if (jsonLines.length > 0) {
            resolve(JSON.parse(jsonLines[jsonLines.length - 1]));
          } else {
            resolve({ output: stdout, format: 'text', success: true });
          }
        } catch (error) {
          resolve({ output: stdout, format: 'text', success: true });
        }
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to start claude-code: ${error.message}`));
      });

      // 超时处理
      setTimeout(() => {
        child.kill();
        reject(new Error('claude-code execution timeout'));
      }, this.timeout);
    });
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
    let prompt = task.description;

    if (task.files && task.files.length > 0) {
      prompt += `\n\n## 相关文件\n请分析以下文件：\n${task.files.map(f => `- ${f}`).join('\n')}`;
    }

    if (task.context && task.context.architecture_rules) {
      prompt += `\n\n## 架构规则\n${task.context.architecture_rules}`;
    }

    if (task.context && task.context.quality_rules) {
      prompt += `\n\n## 质量要求\n${task.context.quality_rules}`;
    }

    if (task.context && task.context.milestone) {
      prompt += `\n\n## 当前里程碑\n${task.context.milestone}`;
    }

    prompt += `\n\n## 输出要求\n请以 JSON 格式返回执行结果，包含：files_created, files_modified, summary, tests_run`;

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
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        await execAsync(`${this.cliPath} --version`);
        return true;
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
