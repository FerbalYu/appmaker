/**
 * Execution Engine
 *
 * 核心特性：
 * - 智能重试机制（网络错误自动重试）
 * - 任务超时控制（防止无限等待）
 * - 动态并行调度（根据依赖关系优化并发）
 * - 资源预算管理（token 消耗追踪）
 * - 多层次检查点（里程碑 + 手动）
 */

import { AgentDispatcher } from './agents/dispatcher.js';
import { NativeCoderAdapter } from './agents/native-coder.js';
import { NativeReviewerAdapter } from './agents/native-reviewer.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ExecutionEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      max_review_cycles: 10,
      task_timeout: 300000,
      max_retries: 2,
      max_concurrent_tasks: 3,
      token_budget: 50000000,
      idle_timeout_ms: 1800000,
      ...config,
    };

    this.tasks = new Map();
    this.checkpoints = [];
    this.logs = [];
    this.maxReviewCycles = this.config.max_review_cycles;
    this.tokenUsage = { total: 0, byAgent: {} };
    this.halt = false;
    this.aborted = false;
    this.paused = false;

    this.projectRoot = this.config.project_root || process.cwd();

    this.dispatcher = new AgentDispatcher({
      native_reviewer_model: config.native_reviewer_model || 'MiniMax-Text-01',
      native_coder_model: config.native_coder_model || 'MiniMax-Text-01',
      request_timeout: this.config.task_timeout,
      max_retries: this.config.max_retries,
    });

    this.dispatcher.registerAgent('native-reviewer', () => {
      const adapter = new NativeReviewerAdapter({
        model: config.native_reviewer_model,
        api_key: config.api_key || process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY,
        api_host: config.api_host || process.env.OPENAI_API_BASE || process.env.MINIMAX_API_HOST,
        project_root: this.projectRoot,
      });
      adapter.on('action', (act) =>
        this.emit('agent:action', { ...act, agent: 'native-reviewer' }),
      );
      return adapter;
    });
    this.dispatcher.registerAgent('native-coder', () => {
      const adapter = new NativeCoderAdapter({
        model: config.native_coder_model,
        api_key: config.api_key || process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY,
        api_host: config.api_host || process.env.OPENAI_API_BASE || process.env.MINIMAX_API_HOST,
        project_root: this.projectRoot,
      });
      adapter.on('action', (act) => this.emit('agent:action', { ...act, agent: 'native-coder' }));
      return adapter;
    });
  }

  /**
   * 执行任务（编程 + 评审循环）
   * @param {Object} plan
   * @returns {Promise<Object>}
   */
  async execute(plan) {
    this._log('INFO', `🚀 开始执行计划: ${plan.project.name}`);
    this._log(
      'INFO',
      `📋 总任务数: ${plan.tasks.length} | Token 预算: ${this.config.token_budget}`,
    );

    const results = [];
    const startTime = Date.now();

    for (const milestone of plan.milestones) {
      this._log('INFO', `\n${'═'.repeat(50)}`);
      this._log('INFO', `🏁 里程碑: ${milestone.name}`);
      this._log('INFO', `${'═'.repeat(50)}`);
      this.emit('milestone:start', { milestone, plan });

      const milestoneResults = await this._executeMilestone(milestone, plan);
      results.push(...milestoneResults);

      await this._createCheckpoint(`milestone_${milestone.id}`);
      this._log('INFO', `✅ 里程碑 "${milestone.name}" 完成`);
      this.emit('milestone:done', { milestone, plan });

      // 强制内存回收
      if (global.gc) {
        try {
          global.gc();
          this._log('DEBUG', `🧹 执行强制垃圾回收 (Milestone: ${milestone.name})`);
        } catch (e) {
          this._log('DEBUG', `🧹 垃圾回收失败: ${e.message}`);
        }
      }

      if (this.halt || this.aborted) {
        this._log('WARN', '⚠️ 任务被外部强行中止');
        break;
      }
    }

    const summary = this._generateSummary(results, startTime);
    this.emit('plan:done', { plan, summary, results });

    this._log('INFO', `\n${'═'.repeat(50)}`);
    this._log('INFO', `📊 执行摘要:`);
    this._log(
      'INFO',
      `   成功: ${summary.done} | 失败: ${summary.failed} | 需人工: ${summary.needs_human}`,
    );
    this._log('INFO', `   Token 消耗: ${this.tokenUsage.total} / ${this.config.token_budget}`);
    this._log('INFO', `   总耗时: ${Math.round(summary.duration_ms / 1000)}s`);
    this._log('INFO', `${'═'.repeat(50)}`);

    return {
      plan_id: plan.plan_id,
      status: summary.failed > 0 ? 'partial' : 'success',
      results,
      summary,
      tokenUsage: this.tokenUsage,
    };
  }

  /**
   * 执行单个里程碑（智能并行调度）
   * @private
   */
  async _executeMilestone(milestone, plan) {
    const results = [];
    const milestoneTasks = milestone.tasks
      .map((id) => plan.tasks.find((t) => t.id === id))
      .filter((t) => {
        if (!t) this._log('WARN', `任务 ID ${id} 未找到`);
        return Boolean(t);
      });

    const taskGraph = this._buildTaskGraph(milestoneTasks);
    const maxConcurrent = Math.min(this.config.max_concurrent_tasks, milestoneTasks.length);

    const executing = new Map();
    const completed = new Map();

    while (completed.size < milestoneTasks.length) {
      const availableTasks = this._getAvailableTasks(taskGraph, executing, completed);

      if (
        executing.size === 0 &&
        availableTasks.length === 0 &&
        completed.size < milestoneTasks.length
      ) {
        const blocked = milestoneTasks.filter((t) => !completed.has(t.id) && !executing.has(t.id));
        if (blocked.length > 0) {
          this._log('ERROR', `检测到死锁！${blocked.length} 个任务无法完成`);
          for (const task of blocked) {
            const errorResult = { task_id: task.id, status: 'deadlock', error: '任务依赖无法满足' };
            results.push(errorResult);
            completed.set(task.id, errorResult);
          }
        }
        break;
      }

      while (executing.size < maxConcurrent && availableTasks.length > 0 && !this.halt) {
        const task = availableTasks.shift();
        this._log('INFO', `[${task.id}] 调度执行 (依赖: ${task.dependencies?.length || 0})`);

        const promise = this._executeTaskWithTimeout(task, plan)
          .then((result) => {
            results.push(result);
            this.tasks.set(task.id, { status: result.status, result });
            this._reportProgress(task, result);
            this._trackTokenUsage(result);
            completed.set(task.id, result);
            return result;
          })
          .catch((error) => {
            const errorResult = { task_id: task.id, status: 'failed', error: error.message };
            results.push(errorResult);
            this.tasks.set(task.id, { status: 'failed', result: errorResult });
            this._reportProgress(task, errorResult);
            completed.set(task.id, errorResult);
            return errorResult;
          })
          .finally(() => executing.delete(task.id));

        executing.set(task.id, promise);
      }

      if (executing.size > 0) {
        await Promise.race(executing.values());
      }

      // Check for pause
      while (this.paused && !this.halt && !this.aborted) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (this.halt || this.aborted) {
        this._log('WARN', '执行被中止，等待运行中的任务完成...');
        await Promise.allSettled(executing.values());
        break;
      }
    }

    await Promise.allSettled(executing.values());
    return results;
  }

  /**
   * 构建任务依赖图
   * @private
   */
  _buildTaskGraph(tasks) {
    const graph = new Map();
    for (const task of tasks) {
      graph.set(task.id, {
        task,
        dependencies: new Set(task.dependencies || []),
        dependents: new Set(),
      });
    }
    for (const [id, node] of graph) {
      for (const depId of node.dependencies) {
        if (graph.has(depId)) {
          graph.get(depId).dependents.add(id);
        }
      }
    }
    return graph;
  }

  /**
   * 获取可执行的任务（依赖已满足）
   * @private
   */
  _getAvailableTasks(graph, executing, completed) {
    const available = [];
    for (const [id, node] of graph) {
      if (completed.has(id) || executing.has(id)) continue;

      const depsSatisfied = [...node.dependencies].every(
        (depId) =>
          (completed.has(depId) && completed.get(depId)?.status === 'done') ||
          (this.tasks.has(depId) && this.tasks.get(depId)?.status === 'done'),
      );

      if (depsSatisfied) {
        available.push(node.task);
      }
    }
    return available;
  }

  /**
   * 带超时的任务执行
   * @private
   */
  async _executeTaskWithTimeout(task, plan) {
    // 移除严格的总时间超时限制，依靠底层 API 和工具自带的超时机制
    // 允许涉及长耗时命令（如大文件处理、npm install等）的任务安全完成
    return this._executeTask(task, plan);
  }

  /**
   * 追踪 token 使用
   * @private
   */
  _trackTokenUsage(result) {
    const codeTokens = result.code_result?.metrics?.tokens_used || 0;
    const reviewTokens = result.review_result?.output?.metrics?.tokens_used || 0;

    this.tokenUsage.total += codeTokens + reviewTokens;
    this.tokenUsage.byAgent['native-coder'] =
      (this.tokenUsage.byAgent['native-coder'] || 0) + codeTokens;
    this.tokenUsage.byAgent['native-reviewer'] =
      (this.tokenUsage.byAgent['native-reviewer'] || 0) + reviewTokens;

    if (this.tokenUsage.total > this.config.token_budget) {
      // Just emit warning, do NOT halt
      this.emit('budget:exceeded', { usage: this.tokenUsage, budget: this.config.token_budget });
    }
  }

  /**
   * Pause execution
   */
  pause() {
    this.paused = true;
    this._log('INFO', '⏸️ 引擎已挂起 (Paused)');
    this.emit('engine:paused');
  }

  /**
   * Resume execution
   */
  resume() {
    this.paused = false;
    this._log('INFO', '▶️ 引擎恢复运行 (Resumed)');
    this.emit('engine:resumed');
  }

  /**
   * 执行单个任务：编程 → 评审 → 修正循环
   * @private
   */
  async _executeTask(task, plan) {
    this.emit('task:start', { task, plan });
    this._log('INFO', `\n[${task.id}] 开始: ${task.description}`);

    const context = await this._buildContext(task, plan);
    let codeResult;
    let reviewResult;
    let cycle = 0;

    codeResult = await this._executeWithRetry(
      async () => {
        this._log('INFO', `[${task.id}] 🤖 native-coder 编程中...`);
        return this.dispatcher.dispatch({
          id: task.id,
          type: task.type || 'create',
          description: task.description,
          subtasks: task.subtasks || [],
          files: task.files || [],
          context,
        });
      },
      {
        maxRetries: this.config.max_retries,
        taskId: task.id,
        phase: 'code',
        context,
      },
    );

    if (!codeResult || codeResult.status === 'failed' || codeResult.success === false) {
      const errorMsg = codeResult?.error || codeResult?.errors || 'Unknown error';
      this._log('ERROR', `[${task.id}] ❌ native-coder 执行失败: ${errorMsg}`);
      const errRes = { task_id: task.id, status: 'failed', phase: 'code', error: errorMsg };
      this.emit('task:error', { task, result: errRes });
      return errRes;
    }

    const filesCreated = codeResult.output?.files_created || [];
    const filesModified = codeResult.output?.files_modified || [];
    const totalFilesChanged = filesCreated.length + filesModified.length;

    if (!task.subtasks || task.subtasks.length === 0) {
      task.subtasks = [
        ...filesCreated.map(f => `创建文件并完善逻辑: ${f}`),
        ...filesModified.map(f => `修改代码并验证安全合规: ${f}`)
      ];
      if (task.subtasks.length > 0) {
        this._log('INFO', `[${task.id}] 自动根据变更生成对应的 ${task.subtasks.length} 项子任务用于评审`);
      }
    }

    if (totalFilesChanged === 0) {
      this._log('WARN', `[${task.id}] ⚠️ native-coder 本次执行没有生成或修改任何文件`);
    } else {
      this._log('INFO', `[${task.id}] ✅ 编程完成，文件变更数: ${totalFilesChanged}`);
    }

    reviewResult = await this._executeWithRetry(
      async () => {
        this._log('INFO', `[${task.id}] 🔍 native-reviewer 审查代码中...`);
        return this.dispatcher.dispatch({
          id: `review_${task.id}`,
          type: 'review',
          description: `评审任务: ${task.description}`,
          subtasks: task.subtasks || [],
          files: [
            ...(codeResult.output?.files_created || []),
            ...(codeResult.output?.files_modified || []),
          ],
          context,
        });
      },
      {
        maxRetries: this.config.max_retries,
        taskId: task.id,
        phase: 'review',
        context,
      },
    );

    this.emit('task:review', { task, result: reviewResult });

    if (!reviewResult) {
      this._log('ERROR', `[${task.id}] ❌ native-reviewer 评审失败`);
      return { task_id: task.id, status: 'failed', phase: 'review', error: 'Review agent failed' };
    }

    const reviewScore = reviewResult.output?.score ?? 100;
    const reviewIssues = reviewResult.output?.issues || [];
    const reviewComments = reviewResult.output?.summary || reviewResult.output?.comments || '';
    const REVIEW_THRESHOLD = 85;
    const needsFix = reviewScore < REVIEW_THRESHOLD;

    while (needsFix && cycle < this.maxReviewCycles) {
      cycle++;
      this._log('WARN', `[${task.id}] 🔄 评审 FAIL (第 ${cycle} 次修正)`);
      this._logIssues(reviewIssues);

      const fixPrompt = this._buildFixPrompt(task, codeResult, reviewResult, reviewComments);

      codeResult = await this._executeWithRetry(
        async () => {
          return this.dispatcher.dispatch({
            id: `${task.id}_fix_${cycle}`,
            type: 'modify',
            description: fixPrompt,
            subtasks: task.subtasks || [],
            files: [
              ...(codeResult.output?.files_created || []),
              ...(codeResult.output?.files_modified || []),
            ],
            context,
          });
        },
        {
          maxRetries: this.config.max_retries,
          taskId: task.id,
          phase: 'fix',
          context,
        },
      );

      if (!codeResult) {
        this._log('ERROR', `[${task.id}] ❌ 修正失败`);
        return {
          task_id: task.id,
          status: 'failed',
          phase: 'fix',
          cycle,
          error: 'Fix iteration failed',
        };
      }

      reviewResult = await this.dispatcher.dispatch({
        id: `review_${task.id}_${cycle}`,
        type: 'review',
        description: `重新评审: ${task.description}`,
        subtasks: task.subtasks || [],
        files: [
          ...(codeResult.output?.files_created || []),
          ...(codeResult.output?.files_modified || []),
        ],
        context,
      });

      if (!reviewResult) {
        this._log('ERROR', `[${task.id}] ❌ 重新评审失败`);
        return {
          task_id: task.id,
          status: 'failed',
          phase: 're-review',
          cycle,
          error: 'Re-review failed',
        };
      }

      const newScore = reviewResult.output?.score ?? 100;
      if (newScore >= REVIEW_THRESHOLD) {
        this._log('INFO', `[${task.id}] ✅ 修正后评分提升至 ${newScore}`);
        break;
      }
    }

    if (needsFix && cycle >= this.maxReviewCycles) {
      this._log('ERROR', `[${task.id}] ⚠️ 超过最大修正次数 (${this.maxReviewCycles})，需人工介入`);
      this._log('WARN', `[${task.id}] 最终评分: ${reviewScore}`);
      return {
        task_id: task.id,
        status: 'needs_human',
        phase: 'exhausted',
        cycles: cycle,
        score: reviewScore,
        issues: reviewIssues,
        comments: reviewComments,
        code_result: codeResult,
      };
    }

    const verdict = reviewScore >= REVIEW_THRESHOLD ? 'PASS' : 'FAIL';
    const verdictIcon = verdict === 'PASS' ? '✅' : '❌';
    this._log('INFO', `[${task.id}] ${verdictIcon} ${verdict} (评分: ${reviewScore})`);

    const finalResult = {
      task_id: task.id,
      status: 'done',
      verdict,
      score: reviewScore,
      cycles: cycle,
      code_result: codeResult,
      review_result: reviewResult,
    };
    this.emit('task:done', { task, result: finalResult });
    return finalResult;
  }

  /**
   * 带重试的执行包装器
   * @private
   */
  async _executeWithRetry(fn, options = {}) {
    const { maxRetries = 2, taskId, phase, context } = options;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      let abortController = new AbortController();
      if (context) context.abortController = abortController;

      let lastActionTime = Date.now();
      const onAction = () => {
        lastActionTime = Date.now();
      };
      this.on('agent:action', onAction);

      const heartbeatInterval = setInterval(() => {
        if (Date.now() - lastActionTime > this.config.idle_timeout_ms) {
          this._log(
            'ERROR',
            `[${taskId}] ⚠️ Agent 发呆超过 ${this.config.idle_timeout_ms / 1000}s, 触发心跳打断...`,
          );
          abortController.abort(new Error('STALLED_HEARTBEAT'));
        }
      }, 10000);

      try {
        const result = await fn();
        if (result && result.success === false && result.error) {
          const errObj = result.error;
          const errMsg =
            typeof errObj === 'string'
              ? errObj
              : errObj.message || errObj.type || JSON.stringify(errObj);
          throw new Error(errMsg);
        }
        return result;
      } catch (error) {
        lastError = error;
        const isStalled =
          error.message === 'STALLED_HEARTBEAT' ||
          error.name === 'AbortError' ||
          (error.cause && error.cause.message === 'STALLED_HEARTBEAT');

        if (this._isRetryableError(error) || isStalled) {
          if (attempt <= maxRetries) {
            let delay = Math.pow(2, attempt - 1) * 1000;
            if (
              error.message &&
              (error.message.includes('529') ||
                error.message.includes('overloaded_error') ||
                error.message.includes('429') ||
                error.message.toLowerCase().includes('rate limit'))
            ) {
              delay = 120 * 1000; // Force 120 seconds backoff for overload/rate-limits
            }
            const reason = isStalled ? '执行卡死发呆/超时中止' : error.message;
            this._log(
              'WARN',
              `[${taskId}] 🔁 ${phase} 失败，${delay}ms 后重试 (${attempt}/${maxRetries}): ${reason}`,
            );
            this.emit('task:retry_wait', {
              task_id: taskId,
              phase,
              delay_ms: delay,
              attempt,
              max_retries: maxRetries,
              error: reason,
            });
            await this._sleep(delay);
          } else {
            this._log(
              'ERROR',
              `[${taskId}] ❌ ${phase} 在 ${maxRetries} 次重试后仍然失败: ${error.message}`,
            );
            return { success: false, error: lastError.message, status: 'failed' };
          }
        } else {
          this._log('ERROR', `[${taskId}] ❌ ${phase} 非重试性错误: ${error.message}`);
          return { success: false, error: lastError.message, status: 'failed' };
        }
      } finally {
        clearInterval(heartbeatInterval);
        this.off('agent:action', onAction);
      }
    }

    return null;
  }

  /**
   * 判断错误是否可重试
   * @private
   */
  _isRetryableError(error) {
    const retryablePatterns = [
      'timeout',
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'network',
      'rate limit',
      '429',
      '500',
      '502',
      '503',
      '504',
      'socket hang up',
      'Request timeout',
      'fetch',
      'api error',
      '响应结构异常',
      'json',
      'parse error',
      '1000',
      '1001',
      '1002',
      '1024',
      '1033',
      '2045',
      '2056',
    ];

    const errorMsg = (error?.message || '').toLowerCase();
    return retryablePatterns.some((pattern) => errorMsg.includes(pattern.toLowerCase()));
  }

  /**
   * 睡眠工具
   * @private
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _buildContext(task, plan) {
    return {
      task_id: task.id,
      project_root: this.projectRoot,
      architecture_rules: await this._loadRule('architecture'),
      quality_rules: await this._loadRule('quality'),
      checkpoint: this.checkpoints[this.checkpoints.length - 1],
    };
  }

  async _loadRule(ruleName) {
    try {
      const rulePath = path.join(__dirname, '..', 'rules', `${ruleName}.rules.md`);
      return await fs.readFile(rulePath, 'utf-8');
    } catch {
      return '';
    }
  }

  _buildFixPrompt(task, codeResult, reviewResult, reviewComments) {
    const issues = reviewResult.output?.issues || [];
    let issueList;

    if (issues.length > 0 && typeof issues[0] === 'string') {
      issueList = issues.map((issue, i) => `${i + 1}. [待修复] ${issue}`).join('\n');
    } else {
      issueList = issues
        .map(
          (issue, i) =>
            `${i + 1}. [${issue.severity}] ${issue.title}\n   文件: ${issue.file}\n   问题: ${issue.reason}\n   建议: ${issue.suggestion}`,
        )
        .join('\n');
    }

    if (!issueList) {
      issueList = `评审意见: ${reviewComments || '评分过低 (score < 60)'}`;
    }

    return `修正以下代码中的问题：

任务: ${task.description}

需修正的问题:
${issueList}

${reviewComments ? `评审原话: "${reviewComments}"` : ''}

请根据以上问题修改代码，确保：
1. 所有 CRITICAL 问题必须修复
2. 所有 WARNING 问题尽量修复
3. 保持原有功能不变

修改后确保代码通过质量检查。`;
  }

  _logIssues(issues) {
    for (const issue of issues) {
      if (typeof issue === 'string') {
        this._log('WARN', `  🟡 ${issue}`);
      } else {
        const icon =
          issue.severity === 'CRITICAL' ? '🔴' : issue.severity === 'WARNING' ? '🟡' : '🟢';
        this._log('WARN', `  ${icon} ${issue.title} (${issue.file || 'unknown'})`);
      }
    }
  }

  _reportProgress(task, result) {
    const total = this.tasks.size;
    const done = [...this.tasks.values()].filter((t) => t.status === 'done').length;
    const pct = Math.round((done / total) * 100);
    console.log(`\n[PROGRESS] ${done}/${total} (${pct}%)`);
    console.log(`  █${'█'.repeat(Math.floor(pct / 5))}${'░'.repeat(20 - Math.floor(pct / 5))}`);
  }

  async _createCheckpoint(name) {
    const checkpoint = {
      id: `cp_${Date.now()}`,
      name,
      timestamp: new Date().toISOString(),
      tasks: Object.fromEntries(this.tasks),
      logs: this.logs.slice(-100),
    };
    this.checkpoints.push(checkpoint);

    try {
      const dir = path.join(this.projectRoot, '.ncf', 'checkpoints');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, `${checkpoint.id}.json`),
        JSON.stringify(checkpoint, null, 2),
      );
    } catch {
      /* ignore */
    }

    this._log('INFO', `检查点创建: ${name}`);
    return checkpoint.id;
  }

  _generateSummary(results, startTime) {
    const done = results.filter((r) => r.status === 'done').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const needsHuman = results.filter((r) => r.status === 'needs_human').length;
    const totalCycles = results.reduce((sum, r) => sum + (r.cycles || 0), 0);
    const avgScore = results.reduce((sum, r) => sum + (r.score || 0), 0) / (results.length || 1);

    return {
      total: results.length,
      done,
      failed,
      needs_human: needsHuman,
      total_review_cycles: totalCycles,
      average_score: Math.round(avgScore),
      duration_ms: Date.now() - startTime,
    };
  }

  _log(level, message) {
    const entry = { timestamp: new Date().toISOString(), level, message };
    this.logs.push(entry);
    console.log(`[${level}] ${message}`);
  }

  async restore(checkpointId) {
    try {
      const cp = await fs.readFile(
        path.join(this.projectRoot, '.ncf', 'checkpoints', `${checkpointId}.json`),
        'utf-8',
      );
      const checkpoint = JSON.parse(cp);
      this.tasks = new Map(Object.entries(checkpoint.tasks));
      this.checkpoints.push(checkpoint);
      this._log('INFO', `已恢复检查点: ${checkpointId}`);
      return checkpoint;
    } catch (error) {
      this._log('ERROR', `恢复失败: ${error.message}`);
      return null;
    }
  }
}
