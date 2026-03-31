/**
 * OpenCode Adapter - 毒舌点评模式
 * 负责 Code Review 和质量把控，不写代码，只挑毛病
 */

const { AgentAdapter } = require('./base');

const OPENCODE_CONFIG = {
  name: 'opencode',
  type: 'reviewer',
  capabilities: [
    'code-review',
    'quality-critique',
    'bug-detection',
    'style-enforcement',
    'quick-feedback'
  ]
};

class OpenCodeAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...OPENCODE_CONFIG, ...config });
    this.cliPath = config.cli_path || 'opencode';
    this.apiEndpoint = config.api_endpoint || 'http://localhost:3000';
    this.timeout = config.timeout || 60000; // 评审模式 1 分钟
  }

  /**
   * 执行毒舌点评
   * @param {Object} task
   * @returns {Promise<Object>}
   */
  async execute(task) {
    const startTime = Date.now();

    const reviewPrompt = this._buildReviewPrompt(task);

    try {
      let result;
      if (this.config.use_cli) {
        result = await this._reviewViaCLI(reviewPrompt, task.context);
      } else {
        result = await this._reviewViaAPI(reviewPrompt, task.context);
      }
      return this._formatReviewResult(result, startTime, task.id);
    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * 构建毒舌评审 prompt
   * @private
   */
  _buildReviewPrompt(task) {
    const { description, files = [], context = {} } = task;

    let prompt = `【毒舌评审模式】

你要对以下代码/变更进行犀利点评。记住：你的任务是挑毛病，不是写代码！

## 评审任务
${description}

## 需要评审的文件
${files.length > 0 ? files.map(f => `- ${f}`).join('\n') : '（无指定文件！）'}

**重要**: 如果没有文件可评审，必须返回 verdict="FAIL"！

## 评审维度

1. **逻辑问题** — 有 bug 吗？边界情况处理了吗？
2. **安全漏洞** — 有 SQL 注入/XSS/敏感信息泄露风险吗？
3. **性能隐患** — 循环嵌套、N+1 查询、内存泄漏？
4. **代码风格** — 命名诡异、函数太长、注释缺失？
5. **可维护性** — 改需求时会不会改到吐血？

## 输出格式

必须返回 JSON：
\`\`\`json
{
  "verdict": "PASS | FAIL | CONDITIONAL_PASS",
  "score": 0-100,
  "issues": [
    {
      "severity": "CRITICAL | WARNING | INFO",
      "file": "文件路径",
      "line": "行号（如果能定位）",
      "title": "问题标题",
      "reason": "为什么这是个问题",
      "suggestion": "怎么改"
    }
  ],
  "summary": "一句话总结这次评审",
  "compliments": "难得一见的亮点（找不到就说'没有'）"
}
\`\`\`

## 毒舌规则
- 必须找到至少 3 个问题（找不到说明代码太简单没价值）
- 批评要有建设性，不能只骂不给解决方案
- 适当调侃，但不能说脏话
- 找不到亮点就直接说，彩虹屁滚远点

开始评审！`;

    if (context.architecture_rules) {
      prompt += `\n\n## 架构规则（违反必扣分）\n${context.architecture_rules}`;
    }

    if (context.quality_rules) {
      prompt += `\n\n## 质量标准\n${context.quality_rules}`;
    }

    return prompt;
  }

  /**
   * 通过 CLI 执行评审
   * @private
   */
  async _reviewViaCLI(prompt, context) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    let cmd = `${this.cliPath} "${prompt.replace(/"/g, '\\"')}"`;

    if (context && context.project_root) {
      cmd += ` --project "${context.project_root}"`;
    }

    const { stdout, stderr } = await execAsync(cmd, { timeout: this.timeout });

    if (stderr && !stdout) {
      throw new Error(stderr);
    }

    // 尝试提取 JSON
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    return { output: stdout, success: true };
  }

  /**
   * 通过 API 执行评审
   * @private
   */
  async _reviewViaAPI(prompt, context) {
    const http = require('http');

    const requestBody = JSON.stringify({
      prompt,
      mode: 'review',
      context
    });

    return new Promise((resolve, reject) => {
      const url = new URL(this.apiEndpoint + '/review');
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
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid review response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });
  }

  /**
   * 格式化评审结果
   * @private
   */
  _formatReviewResult(rawResult, startTime, taskId) {
    const duration = Date.now() - startTime;

    return {
      task_id: taskId || 'unknown',
      agent: this.name,
      type: 'review',
      status: rawResult.verdict ? 'completed' : 'failed',
      output: {
        verdict: rawResult.verdict || 'FAIL',
        score: rawResult.score || 0,
        issues: rawResult.issues || [],
        summary: rawResult.summary || '',
        compliments: rawResult.compliments || ''
      },
      metrics: {
        duration_ms: duration,
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
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      await execAsync(`${this.cliPath} --version`);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { OpenCodeAdapter };
