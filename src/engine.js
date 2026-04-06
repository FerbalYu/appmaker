/**
 * Execution Engine
 *
 * 核心特性：
 * - 智能重试机制（网络错误自动重试）
 * - 任务超时控制（防止无限等待）
 * - 动态并行调度（根据依赖关系优化并发）
 * - Token 消耗追踪
 * - 多层次检查点（里程碑 + 手动）
 */

import { AgentDispatcher } from './agents/dispatcher.js';
import { NativeCoderAdapter } from './agents/native-coder.js';
import { NativeReviewerAdapter } from './agents/native-reviewer.js';
import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { ProgressLedger } from './convergence/progress-ledger.js';
import { IssueFingerprintEngine } from './convergence/issue-fingerprint-engine.js';
import { ReviewConvergenceController } from './convergence/review-convergence-controller.js';
import { ExecutionPolicyEngine } from './convergence/execution-policy-engine.js';
import { ProjectStateProbe } from './convergence/project-state-probe.js';
import { RecoveryCoordinator } from './convergence/recovery-coordinator.js';
import { REVIEW_ERROR_CODES } from './review/error-codes.js';
import { ReleaseObserver } from './ops/release-observer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ExecutionEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      max_review_cycles: 0,
      task_timeout: 0,
      max_retries: 2,
      max_concurrent_tasks: 3,
      idle_timeout_ms: 1800000,
      enable_idle_abort: false,
      heartbeat_check_interval_ms: 10000,
      convergence: {
        window_size: 3,
        min_score_delta: 3,
        max_repeat_issue_rate: 0.7,
        max_parse_failures: 2,
        diminishing_streak_required: 2,
        soft_stop_enabled: true,
        handoff_enabled: true,
      },
      review: {
        input_gate_enabled: true,
        parser_fallback_enabled: true,
        retry_by_error_code: true,
      },
      feature_flags: {
        controller: true,
        gate: true,
        parser: true,
        fingerprint: true,
      },
      state_probe: {
        enabled: true,
        strict: false,
      },
      recovery: {
        enabled: true,
        max_recoveries_per_milestone: 2,
        enable_probe_replan: true,
      },
      ab_test: {
        enabled: false,
        mode: 'shadow',
      },
      observability: {
        structured_json_logs: true,
        alerts: {
          long_run_ms: 60 * 60 * 1000,
          retry_burst: 2,
          parse_failure_storm: 1,
        },
      },
      release: {
        enabled: false,
        observation_window_days: 7,
        auto_generate_report: true,
      },
      ...config,
    };

    this.tasks = new Map();
    this.checkpoints = [];
    this.logs = [];
    this.maxReviewCycles = this.config.max_review_cycles;
    this.tokenUsage = { total: 0, byAgent: {} };
    this.abStats = {
      enabled: this.config.ab_test?.enabled === true,
      mode: this.config.ab_test?.mode || 'shadow',
      total_compares: 0,
      divergence_count: 0,
      samples: [],
    };
    this.featureFlagAudit = [];
    this.alerts = [];
    this.policyEngine = new ExecutionPolicyEngine();
    this.stateProbe = new ProjectStateProbe(this.config.state_probe);
    this.recoveryCoordinator = new RecoveryCoordinator(this.config.recovery);
    this.recoveryStats = {
      attempts: 0,
      recovered_tasks: 0,
      replanned_tasks: 0,
      decisions: [],
    };
    this.goalInvariant = null;
    this.halt = false;
    this.aborted = false;
    this.paused = false;

    this.projectRoot = this.config.project_root || process.cwd();
    this.releaseObserver = new ReleaseObserver(this.projectRoot, this.config.release);

    this.dispatcher = new AgentDispatcher({
      native_reviewer_model: config.native_reviewer_model || 'MiniMax-Text-01',
      native_coder_model: config.native_coder_model || 'MiniMax-Text-01',
      request_timeout: this.config.task_timeout,
      max_retries: this.config.max_retries,
      workspace_root: this.projectRoot,
    });

    this.dispatcher.registerAgent('native-reviewer', () => {
      const adapter = new NativeReviewerAdapter({
        model: config.native_reviewer_model,
        api_key: config.api_key || process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY,
        api_host: config.api_host || process.env.OPENAI_API_BASE || process.env.MINIMAX_API_HOST,
        project_root: this.projectRoot,
        review: this.config.review,
        feature_flags: this.config.feature_flags,
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
      `📋 总任务数: ${plan.tasks.length}`,
    );
    this.goalInvariant = this._buildGoalInvariant(plan);
    await this._runStateProbe(plan);

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
    if (summary.duration_ms > (this.config.observability?.alerts?.long_run_ms || 60 * 60 * 1000)) {
      this._emitAlert('LONG_RUNNING_EXECUTION', 'warning', {
        duration_ms: summary.duration_ms,
        threshold_ms: this.config.observability?.alerts?.long_run_ms || 60 * 60 * 1000,
      });
    }
    this.emit('plan:done', { plan, summary, results });
    if (this.config.release?.enabled) {
      const observationState = await this.releaseObserver.recordRun(summary);
      summary.release_observation = {
        window: observationState?.window || null,
        total_runs: observationState?.aggregates?.total_runs || 0,
      };
      if (this.config.release?.auto_generate_report) {
        const report = this.releaseObserver.generateEvaluationReport(summary, observationState);
        const reportPath = await this.releaseObserver.writeEvaluationReport(report);
        summary.final_evaluation_report = reportPath;
      }
    }

    this._log('INFO', `\n${'═'.repeat(50)}`);
    this._log('INFO', `📊 执行摘要:`);
    this._log(
      'INFO',
      `   成功: ${summary.done} | 失败: ${summary.failed} | 阻塞: ${summary.blocked} | 死锁: ${summary.deadlock} | 需人工: ${summary.needs_human}`,
    );
    this._log('INFO', `   Token 消耗: ${this.tokenUsage.total}`);
    this._log('INFO', `   总耗时: ${Math.round(summary.duration_ms / 1000)}s`);
    this._log('INFO', `${'═'.repeat(50)}`);

    return {
      plan_id: plan.plan_id,
      status: summary.failed > 0 || summary.needs_human > 0 ? 'partial' : 'success',
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
          const recovered = await this._attemptRecoverBlockedTasks({
            blocked,
            taskGraph,
            completed,
            milestone,
          });
          if (recovered > 0) {
            this._log(
              'WARN',
              `恢复协调器已解除 ${recovered} 个任务的阻塞依赖，继续执行里程碑 ${milestone.id}`,
            );
            continue;
          }
          let deadlockCount = 0;
          const blockedDetails = [];
          const failedDependencyReasons = new Map();
          for (const task of blocked) {
            const deps = task.dependencies || [];
            const failedDeps = deps.filter((depId) => {
              const depRes = completed.get(depId) || this.tasks.get(depId)?.result;
              const st = depRes?.status;
              return st && st !== 'done';
            });
            const hasFailedDep = failedDeps.length > 0;
            const errorResult = hasFailedDep
              ? { task_id: task.id, status: 'blocked', error: '依赖任务失败或未完成' }
              : { task_id: task.id, status: 'deadlock', error: '任务依赖无法满足' };
            if (errorResult.status === 'deadlock') deadlockCount++;
            if (hasFailedDep) {
              blockedDetails.push(`${task.id} <= [${failedDeps.join(', ')}]`);
              for (const depId of failedDeps) {
                const depRes = completed.get(depId) || this.tasks.get(depId)?.result;
                const reason = depRes?.error || depRes?.result?.error || depRes?.phase || depRes?.status;
                if (!failedDependencyReasons.has(depId)) {
                  failedDependencyReasons.set(depId, reason || 'unknown');
                }
              }
            }
            results.push(errorResult);
            completed.set(task.id, errorResult);
          }
          if (deadlockCount > 0) {
            this._log('ERROR', `检测到死锁！${deadlockCount} 个任务无法完成`);
          } else {
            const detailText = blockedDetails.length > 0 ? ` | ${blockedDetails.join('; ')}` : '';
            this._log('WARN', `任务阻塞：${blocked.length} 个任务因依赖失败无法继续${detailText}`);
            if (failedDependencyReasons.size > 0) {
              const reasonText = [...failedDependencyReasons.entries()]
                .map(([depId, reason]) => `${depId}: ${reason}`)
                .join('; ');
              this._log('ERROR', `请先修复上游失败任务后重试：${reasonText}`);
            }
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
    if (!this.config.task_timeout || this.config.task_timeout <= 0) {
      return this._executeTask(task, plan);
    }
    return Promise.race([
      this._executeTask(task, plan),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Task timeout after ${this.config.task_timeout}ms`));
        }, this.config.task_timeout);
      }),
    ]);
  }

  /**
   * 追踪 token 使用
   * @private
   */
  _trackTokenUsage(result) {
    const codeTokens = result.code_result?.metrics?.tokens_used || 0;
    const reviewTokens = result.review_result?.metrics?.tokens_used || result.review_result?.output?.metrics?.tokens_used || 0;

    this.tokenUsage.total += codeTokens + reviewTokens;
    this.tokenUsage.byAgent['native-coder'] =
      (this.tokenUsage.byAgent['native-coder'] || 0) + codeTokens;
    this.tokenUsage.byAgent['native-reviewer'] =
      (this.tokenUsage.byAgent['native-reviewer'] || 0) + reviewTokens;
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
    const taskStartAt = Date.now();
    if (!task.goal && this.goalInvariant?.summary) {
      task.goal = this.goalInvariant.summary;
    }

    const context = await this._buildContext(task, plan);
    const preflight = await this.stateProbe.evaluateTaskState(task, this.projectRoot);
    if (preflight.already_satisfied) {
      this._log(
        'INFO',
        `[${task.id}] 🧭 状态探针判定任务已满足，跳过重复执行 (${preflight.required_artifacts.join(', ')})`,
      );
      const skipResult = {
        task_id: task.id,
        status: 'done',
        verdict: 'SKIP_ALREADY_SATISFIED',
        score: 100,
        cycles: 0,
        code_result: null,
        review_result: null,
        stop_reason: 'TASK_ALREADY_SATISFIED',
        probe: preflight,
        quality_metrics: {
          critical_clearance_time: 0,
          repeat_issue_rate: 0,
        },
      };
      this.emit('task:done', { task, result: skipResult });
      return skipResult;
    }
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
    await this._attachFileHashes(codeResult);

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

    const executionConfig = this._buildTaskExecutionConfig(task);
    const useController = executionConfig.feature_flags?.controller !== false;
    const useFingerprint = executionConfig.feature_flags?.fingerprint !== false;
    const ledger = new ProgressLedger();
    const fingerprintEngine = useFingerprint ? new IssueFingerprintEngine() : null;
    const convergenceController = useController
      ? new ReviewConvergenceController(executionConfig.convergence)
      : null;

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
          context: {
            ...context,
            review: executionConfig.review,
            feature_flags: executionConfig.feature_flags,
          },
        });
      },
      {
        maxRetries: this.config.max_retries,
        taskId: task.id,
        phase: 'review',
        context,
        retryByErrorCode: executionConfig.review?.retry_by_error_code !== false,
      },
    );

    this.emit('task:review', { task, result: reviewResult });

    if (!reviewResult) {
      this._log('ERROR', `[${task.id}] ❌ native-reviewer 评审失败`);
      return { task_id: task.id, status: 'failed', phase: 'review', error: 'Review agent failed' };
    }

    let reviewOutcome = this._extractReviewOutcome(reviewResult);
    if (!reviewOutcome.ok) {
      ledger.addRound({
        score: 0,
        critical_count: 0,
        issue_count: 0,
        issue_repeat_rate: 0,
        file_change_effective: false,
        parse_failed: reviewOutcome.error_code === REVIEW_ERROR_CODES.PARSE_FAILED,
      });
      const decision = useController ? convergenceController.evaluate(ledger) : { action: 'continue' };
      this._recordAbCompare(task.id, {
        stage: 'initial_review_failure',
        cycle,
        nextDecision: decision.action,
        stopReason: decision.stop_reason || null,
      });
      if (decision.action === 'handoff') {
        return this._buildHumanHandoffResult(task, {
          cycle,
          reviewScore: 0,
          reviewIssues: [],
          reviewComments: reviewOutcome.error,
          codeResult,
          stopReason: decision.stop_reason,
          evidence: decision.evidence,
        });
      }
      return {
        task_id: task.id,
        status: 'failed',
        phase: 'review',
        error: reviewOutcome.error || 'Review output invalid',
        error_code: reviewOutcome.error_code,
      };
    }

    let reviewScore = reviewOutcome.score;
    let reviewIssues = reviewOutcome.issues;
    let reviewComments = reviewOutcome.comments;
    let goalDriftCriticalStreak = this._countGoalDriftCriticalIssues(reviewIssues) > 0 ? 1 : 0;
    let previousIssues = reviewIssues;
    const initialCriticalCount = this._countCriticalIssues(reviewIssues);
    let criticalClearanceTime = initialCriticalCount === 0 ? 0 : null;
    let lastRepeatIssueRate = 0;
    ledger.addRound({
      score: reviewScore,
      critical_count: this._countCriticalIssues(reviewIssues),
      issue_count: reviewIssues.length,
      issue_repeat_rate: 0,
      file_change_effective: true,
      parse_failed: false,
    });
    const REVIEW_THRESHOLD = 85;
    let needsFix = reviewScore < REVIEW_THRESHOLD;

    while (needsFix && (this.maxReviewCycles <= 0 || cycle < this.maxReviewCycles)) {
      cycle++;
      this._log('WARN', `[${task.id}] 🔄 评审 FAIL (第 ${cycle} 次修正)`);
      this._logIssues(reviewIssues);

      const fixTaskQueue = this._buildFixTaskQueue(reviewIssues);
      const fixPrompt = this._buildFixPrompt(task, codeResult, reviewResult, reviewComments, fixTaskQueue);
      const prevCodeResult = codeResult;
      const filesForRollback = [
        ...(codeResult.output?.files_created || []),
        ...(codeResult.output?.files_modified || []),
      ];
      const rollbackSnapshot = await this._captureFileSnapshots(filesForRollback);

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
      await this._attachFileHashes(codeResult);

      reviewResult = await this._executeWithRetry(
        async () => {
          return this.dispatcher.dispatch({
            id: `review_${task.id}_${cycle}`,
            type: 'review',
            description: `重新评审: ${task.description}`,
            subtasks: task.subtasks || [],
            files: [
              ...(codeResult.output?.files_created || []),
              ...(codeResult.output?.files_modified || []),
            ],
            context: {
              ...context,
              review: executionConfig.review,
              feature_flags: executionConfig.feature_flags,
            },
          });
        },
        {
          maxRetries: this.config.max_retries,
          taskId: task.id,
          phase: 're-review',
          context,
          retryByErrorCode: executionConfig.review?.retry_by_error_code !== false,
        },
      );

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

      reviewOutcome = this._extractReviewOutcome(reviewResult);
      const currentGoalDriftCriticalCount = this._countGoalDriftCriticalIssues(reviewOutcome.issues || []);
      goalDriftCriticalStreak = currentGoalDriftCriticalCount > 0 ? goalDriftCriticalStreak + 1 : 0;
      if (goalDriftCriticalStreak >= 2) {
        this._log('WARN', `[${task.id}] ⚠️ 检测到连续目标偏航 CRITICAL，触发强制重规划修复`);
        const forcedReplanResult = await this._executeForcedGoalReplan({
          task,
          cycle,
          context,
          executionConfig,
          reviewIssues: reviewOutcome.issues || [],
          reviewComments: reviewOutcome.comments || reviewOutcome.error || '',
        });
        if (forcedReplanResult) {
          codeResult = forcedReplanResult.codeResult;
          reviewResult = forcedReplanResult.reviewResult;
          reviewOutcome = forcedReplanResult.reviewOutcome;
          reviewScore = reviewOutcome.score || reviewScore;
          reviewIssues = reviewOutcome.issues || reviewIssues;
          reviewComments = reviewOutcome.comments || reviewComments;
          previousIssues = reviewIssues;
          goalDriftCriticalStreak = this._countGoalDriftCriticalIssues(reviewIssues) > 0 ? 1 : 0;
          needsFix = reviewScore < REVIEW_THRESHOLD;
          if (!needsFix) {
            this._log('INFO', `[${task.id}] ✅ 强制重规划后通过评审 (${reviewScore})`);
            break;
          }
        } else {
          return this._buildHumanHandoffResult(task, {
            cycle,
            reviewScore: reviewOutcome.score || reviewScore || 0,
            reviewIssues: reviewOutcome.issues || reviewIssues,
            reviewComments: reviewOutcome.comments || reviewOutcome.error || reviewComments,
            codeResult,
            stopReason: 'GOAL_DRIFT_STORM',
          });
        }
      }
      const fileChangeEffective = this._hasEffectiveFileChange(prevCodeResult, codeResult);
      const repeatRate = useFingerprint
        ? fingerprintEngine.computeRepeatRate(previousIssues, reviewOutcome.issues || [])
        : 0;
      lastRepeatIssueRate = repeatRate;
      const currentCriticalCount = this._countCriticalIssues(reviewOutcome.issues || []);
      if (criticalClearanceTime === null && initialCriticalCount > 0 && currentCriticalCount === 0) {
        criticalClearanceTime = Date.now() - taskStartAt;
      }
      ledger.addRound({
        score: reviewOutcome.score || 0,
        critical_count: currentCriticalCount,
        issue_count: (reviewOutcome.issues || []).length,
        issue_repeat_rate: repeatRate,
        file_change_effective: fileChangeEffective,
        parse_failed: !reviewOutcome.ok && reviewOutcome.error_code === REVIEW_ERROR_CODES.PARSE_FAILED,
      });
      const decision = useController ? convergenceController.evaluate(ledger) : { action: 'continue' };
      this._recordAbCompare(task.id, {
        stage: 're_review',
        cycle,
        nextDecision: decision.action,
        stopReason: decision.stop_reason || null,
      });
      if (decision.action === 'soft_stop') {
        this._log('WARN', `[${task.id}] 触发软停止提示: ${decision.stop_reason}`);
        this._emitAlert('SOFT_STOP_SUGGESTED', 'warning', {
          task_id: task.id,
          cycle,
          evidence: decision.evidence || {},
        });
      }
      if (decision.action === 'handoff') {
        this._log('WARN', `[${task.id}] 触发收敛控制: ${decision.stop_reason}`);
        if (decision.stop_reason === 'PARSE_FAILURE_STORM') {
          this._emitAlert('PARSE_FAILURE_STORM', 'error', {
            task_id: task.id,
            cycle,
            error_category: 'parse',
            error_readable: '评审解析连续失败，已触发风暴告警',
            evidence: decision.evidence || {},
          });
        }
        return this._buildHumanHandoffResult(task, {
          cycle,
          reviewScore: reviewOutcome.score || reviewScore || 0,
          reviewIssues: reviewOutcome.issues || reviewIssues,
          reviewComments: reviewOutcome.comments || reviewOutcome.error || reviewComments,
          codeResult,
          stopReason: decision.stop_reason,
          evidence: decision.evidence,
          qualityMetrics: {
            critical_clearance_time: criticalClearanceTime,
            repeat_issue_rate: lastRepeatIssueRate,
          },
        });
      }

      if (!reviewOutcome.ok) {
        return {
          task_id: task.id,
          status: 'failed',
          phase: 're-review',
          cycle,
          error: reviewOutcome.error || 'Re-review output invalid',
          error_code: reviewOutcome.error_code,
        };
      }

      const newScore = reviewOutcome.score;
      if (
        this._shouldRollbackAndRefix({
          previousScore: reviewScore,
          newScore,
          repeatRate,
          fileChangeEffective,
        })
      ) {
        this._log('WARN', `[${task.id}] 检测到低收益修复，执行局部回滚并二次修复`);
        await this._rollbackFilesFromSnapshot(rollbackSnapshot);
        const rollbackPrompt = this._buildRollbackRefixPrompt(task, reviewIssues, reviewComments);
        codeResult = await this._executeWithRetry(
          async () =>
            this.dispatcher.dispatch({
              id: `${task.id}_rollback_refix_${cycle}`,
              type: 'modify',
              description: rollbackPrompt,
              subtasks: task.subtasks || [],
              files: filesForRollback,
              context: {
                ...context,
                review: executionConfig.review,
                feature_flags: executionConfig.feature_flags,
              },
            }),
          {
            maxRetries: this.config.max_retries,
            taskId: task.id,
            phase: 'rollback-refix',
            context,
          },
        );
        await this._attachFileHashes(codeResult);
      }

      reviewScore = newScore;
      reviewIssues = reviewOutcome.issues;
      reviewComments = reviewOutcome.comments;
      previousIssues = reviewIssues;
      needsFix = reviewScore < REVIEW_THRESHOLD;
      if (newScore >= REVIEW_THRESHOLD) {
        this._log('INFO', `[${task.id}] ✅ 修正后评分提升至 ${newScore}`);
        break;
      }
    }

    if (needsFix && this.maxReviewCycles > 0 && cycle >= this.maxReviewCycles) {
      this._log('ERROR', `[${task.id}] ⚠️ 超过最大修正次数 (${this.maxReviewCycles})，需人工介入`);
      this._log('WARN', `[${task.id}] 最终评分: ${reviewScore}`);
      return {
        task_id: task.id,
        status: 'needs_human',
        phase: 'exhausted',
        stop_reason: 'MAX_REVIEW_CYCLES',
        cycles: cycle,
        score: reviewScore,
        issues: reviewIssues,
        comments: reviewComments,
        code_result: codeResult,
        quality_metrics: {
          critical_clearance_time: criticalClearanceTime,
          repeat_issue_rate: lastRepeatIssueRate,
        },
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
      quality_metrics: {
        critical_clearance_time: criticalClearanceTime,
        repeat_issue_rate: lastRepeatIssueRate,
      },
    };
    this.emit('task:done', { task, result: finalResult });
    return finalResult;
  }

  _countGoalDriftCriticalIssues(issues = []) {
    return (issues || []).filter((issue) => {
      const severity = String(issue?.severity || '').toUpperCase();
      if (severity !== 'CRITICAL') return false;
      const text = `${issue?.title || ''} ${issue?.reason || ''} ${issue?.suggestion || ''}`.toLowerCase();
      return (
        text.includes('目标') ||
        text.includes('goal') ||
        text.includes('偏离') ||
        text.includes('drift') ||
        text.includes('偏航')
      );
    }).length;
  }

  async _executeForcedGoalReplan({
    task,
    cycle,
    context,
    executionConfig,
    reviewIssues = [],
    reviewComments = '',
  }) {
    const forcedPrompt = this._buildForcedGoalReplanPrompt(task, reviewIssues, reviewComments);
    const forcedCodeResult = await this._executeWithRetry(
      async () =>
        this.dispatcher.dispatch({
          id: `${task.id}_goal_replan_${cycle}`,
          type: 'modify',
          description: forcedPrompt,
          subtasks: task.subtasks || [],
          files: task.files || [],
          context: {
            ...context,
            review: executionConfig.review,
            feature_flags: executionConfig.feature_flags,
          },
        }),
      {
        maxRetries: this.config.max_retries,
        taskId: task.id,
        phase: 'goal-replan',
        context,
      },
    );
    if (!forcedCodeResult || forcedCodeResult.status === 'failed' || forcedCodeResult.success === false) {
      return null;
    }
    await this._attachFileHashes(forcedCodeResult);
    const forcedReviewResult = await this._executeWithRetry(
      async () =>
        this.dispatcher.dispatch({
          id: `review_${task.id}_goal_replan_${cycle}`,
          type: 'review',
          description: `强制重规划复审: ${task.description}`,
          subtasks: task.subtasks || [],
          files: [
            ...(forcedCodeResult.output?.files_created || []),
            ...(forcedCodeResult.output?.files_modified || []),
          ],
          context: {
            ...context,
            review: executionConfig.review,
            feature_flags: executionConfig.feature_flags,
          },
        }),
      {
        maxRetries: this.config.max_retries,
        taskId: task.id,
        phase: 'goal-replan-review',
        context,
        retryByErrorCode: executionConfig.review?.retry_by_error_code !== false,
      },
    );
    const forcedReviewOutcome = this._extractReviewOutcome(forcedReviewResult);
    return {
      codeResult: forcedCodeResult,
      reviewResult: forcedReviewResult,
      reviewOutcome: forcedReviewOutcome,
    };
  }

  _buildForcedGoalReplanPrompt(task, reviewIssues = [], reviewComments = '') {
    const issueLines = (reviewIssues || [])
      .slice(0, 6)
      .map(
        (issue, idx) =>
          `${idx + 1}. [${issue.severity || 'UNKNOWN'}] ${issue.title || 'unknown'} - ${
            issue.reason || issue.suggestion || 'no detail'
          }`,
      )
      .join('\n');
    const goalInvariant = this.goalInvariant?.summary || task.goal || '保持原始业务目标不变';
    return `[FORCED_GOAL_REPLAN]
计划可变，目的不可变。你必须先对齐目标，再调整实现路径。

目标不变约束:
${goalInvariant}

最近评审指出目标偏航问题:
${issueLines || '- 无结构化 issue，参考评审摘要'}

评审摘要:
${reviewComments || '无'}

执行要求:
1. 不得更改最终业务目标
2. 允许重排实现步骤与文件落点
3. 输出必须是可审查、可运行的实质修改`;
  }

  /**
   * 带重试的执行包装器
   * @private
   */
  async _executeWithRetry(fn, options = {}) {
    const { maxRetries = 2, taskId, phase, context, retryByErrorCode = null } = options;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      let abortController = new AbortController();
      if (context) context.abortController = abortController;

      let lastActionTime = Date.now();
      const onAction = () => {
        lastActionTime = Date.now();
      };
      this.on('agent:action', onAction);

      const heartbeatInterval = this.config.enable_idle_abort
        ? setInterval(() => {
            if (Date.now() - lastActionTime > this.config.idle_timeout_ms) {
              this._log(
                'ERROR',
                `[${taskId}] ⚠️ Agent 发呆超过 ${this.config.idle_timeout_ms / 1000}s, 触发心跳打断...`,
              );
              abortController.abort(new Error('STALLED_HEARTBEAT'));
            }
          }, this.config.heartbeat_check_interval_ms)
        : null;

      try {
        const result = await fn();
        if (result && result.success === false && result.error) {
          const errObj = result.error;
          const errMsg =
            typeof errObj === 'string'
              ? errObj
              : errObj.message || errObj.type || JSON.stringify(errObj);
          const wrappedError = new Error(errMsg);
          wrappedError.error_code = result.error_code;
          throw wrappedError;
        }
        return result;
      } catch (error) {
        lastError = error;
        const isStalled =
          error.message === 'STALLED_HEARTBEAT' ||
          error.name === 'AbortError' ||
          (error.cause && error.cause.message === 'STALLED_HEARTBEAT');

        const retryDecision =
          retryByErrorCode === false
            ? {
                should_retry: this._isRetryableError(error),
                reason: 'legacy_retry_pattern',
                status_code: null,
                error_code: error?.error_code || null,
                suggested_delay_ms: null,
              }
            : this.policyEngine.getRetryDecision({
                phase,
                error,
                errorCode: error?.error_code,
              });
        const shouldRetry = retryDecision.should_retry;
        if (shouldRetry || isStalled) {
          if (attempt <= maxRetries) {
            if (attempt >= (this.config.observability?.alerts?.retry_burst || 2)) {
              this._emitAlert('ABNORMAL_RETRY_BURST', 'warning', {
                task_id: taskId,
                phase,
                attempt,
                max_retries: maxRetries,
                error: error.message,
                retry_reason: retryDecision.reason,
                status_code: retryDecision.status_code,
                error_code: retryDecision.error_code,
                error_category: 'retry',
                error_readable: '重试次数在短时间内快速累积，疑似异常重试风暴',
              });
            }
            const delay = this._resolveRetryDelay({
              attempt,
              retryDecision,
              isStalled,
            });
            const reason = isStalled ? '执行卡死发呆/超时中止' : error.message;
            this._log(
              'WARN',
              `[${taskId}] 🔁 ${phase} 失败，${delay}ms 后重试 (${attempt}/${maxRetries}) [${retryDecision.reason}]: ${reason}`,
            );
            this.emit('task:retry_wait', {
              task_id: taskId,
              phase,
              delay_ms: delay,
              attempt,
              max_retries: maxRetries,
              error: reason,
              retry_decision: retryDecision,
            });
            await this._sleep(delay);
          } else {
            this._log(
              'ERROR',
              `[${taskId}] ❌ ${phase} 在 ${maxRetries} 次重试后仍然失败: ${error.message}`,
            );
            return {
              success: false,
              error: lastError.message,
              status: 'failed',
              error_code: lastError?.error_code,
            };
          }
        } else {
          this._log('ERROR', `[${taskId}] ❌ ${phase} 非重试性错误: ${error.message}`);
          return {
            success: false,
            error: lastError.message,
            status: 'failed',
            error_code: lastError?.error_code,
          };
        }
      } finally {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
        }
        this.off('agent:action', onAction);
      }
    }

    return null;
  }

  _resolveRetryDelay({ attempt, retryDecision, isStalled = false }) {
    if (isStalled) {
      return 1000;
    }

    if (retryDecision?.suggested_delay_ms && retryDecision.suggested_delay_ms > 0) {
      return retryDecision.suggested_delay_ms;
    }

    const baseDelay = Math.pow(2, attempt - 1) * 1000;
    const capped = Math.min(baseDelay, 120000);
    const jitter = Math.floor(Math.random() * Math.max(250, Math.floor(capped * 0.25)));
    return capped + jitter;
  }

  /**
   * 判断错误是否可重试
   * @private
   */
  _isRetryableError(error) {
    const retryablePatterns = [
      'timeout',
      'timed out',
      'timeout after',
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

  _resolveProjectFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return null;
    const normalized = filePath.replace(/\\/g, '/');
    if (path.isAbsolute(filePath)) return filePath;
    if (/^[A-Za-z]:\//.test(normalized)) return filePath;
    return path.join(this.projectRoot, normalized);
  }

  async _captureFileSnapshots(files = []) {
    const snapshots = [];
    for (const file of files) {
      const fullPath = this._resolveProjectFilePath(file);
      if (!fullPath) continue;
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        snapshots.push({ file, fullPath, existed: true, content });
      } catch {
        snapshots.push({ file, fullPath, existed: false, content: null });
      }
    }
    return snapshots;
  }

  async _rollbackFilesFromSnapshot(snapshots = []) {
    for (const snap of snapshots) {
      if (!snap?.fullPath) continue;
      try {
        if (snap.existed) {
          await fs.writeFile(snap.fullPath, snap.content ?? '', 'utf-8');
        } else {
          await fs.rm(snap.fullPath, { force: true });
        }
      } catch (error) {
        this._log('WARN', `局部回滚失败: ${snap.file} -> ${error.message}`);
      }
    }
  }

  _buildTaskExecutionConfig(task = {}) {
    const contextOverrides = task.context || {};
    const featureFlags = {
      ...(this.config.feature_flags || {}),
      ...(contextOverrides.feature_flags || {}),
      ...(task.feature_flags || {}),
    };
    const review = {
      ...(this.config.review || {}),
      ...(contextOverrides.review || {}),
      ...(task.review || {}),
    };
    const convergence = {
      ...(this.config.convergence || {}),
      ...(contextOverrides.convergence || {}),
      ...(task.convergence || {}),
    };
    return { feature_flags: featureFlags, review, convergence };
  }

  _shouldRollbackAndRefix({ previousScore, newScore, repeatRate, fileChangeEffective }) {
    return (
      Number.isFinite(previousScore) &&
      Number.isFinite(newScore) &&
      newScore <= previousScore &&
      repeatRate >= 0.8 &&
      fileChangeEffective === false
    );
  }

  updateFeatureFlags(nextFlags = {}, meta = {}) {
    const previous = { ...(this.config.feature_flags || {}) };
    this.config.feature_flags = {
      ...(this.config.feature_flags || {}),
      ...(nextFlags || {}),
    };
    const record = {
      timestamp: new Date().toISOString(),
      previous,
      next: { ...this.config.feature_flags },
      reason: meta.reason || 'manual_update',
      actor: meta.actor || 'system',
    };
    this.featureFlagAudit.push(record);
    this._log(
      'WARN',
      `Feature flags updated: ${JSON.stringify({ reason: record.reason, actor: record.actor })}`,
    );
    return record;
  }

  _legacyExpectedDecision() {
    return 'continue';
  }

  _recordAbCompare(taskId, { stage, cycle, nextDecision, stopReason }) {
    if (!this.abStats.enabled || this.abStats.mode !== 'shadow') {
      return;
    }
    const legacyDecision = this._legacyExpectedDecision();
    const diverged = legacyDecision !== nextDecision;
    this.abStats.total_compares += 1;
    if (diverged) {
      this.abStats.divergence_count += 1;
      if (this.abStats.samples.length < 20) {
        this.abStats.samples.push({
          task_id: taskId,
          stage,
          cycle,
          legacy_decision: legacyDecision,
          new_decision: nextDecision,
          stop_reason: stopReason || null,
        });
      }
    }
  }

  async _buildContext(task, plan) {
    return {
      task_id: task.id,
      project_root: this.projectRoot,
      goal_invariant: this.goalInvariant?.summary || '',
      architecture_rules: await this._loadRule('architecture'),
      quality_rules: await this._loadRule('quality'),
      checkpoint: this.checkpoints[this.checkpoints.length - 1],
    };
  }

  async _runStateProbe(plan) {
    if (this.config.state_probe?.enabled === false) {
      return;
    }
    try {
      const snapshot = await this.stateProbe.collectProjectState(this.projectRoot);
      const fileCount = snapshot.files.length;
      const dirCount = snapshot.directories.length;
      this._log('INFO', `🧭 状态探针: 顶层目录 ${dirCount} 个, 文件 ${fileCount} 个`);
      if (plan?.metadata) {
        plan.metadata.state_probe = {
          captured_at: snapshot.captured_at,
          top_level_files: fileCount,
          top_level_directories: dirCount,
        };
      }
    } catch (error) {
      this._log('WARN', `🧭 状态探针执行失败: ${error.message}`);
      if (this.config.state_probe?.strict) {
        throw error;
      }
    }
  }

  async _attemptRecoverBlockedTasks({ blocked, taskGraph, completed, milestone }) {
    if (this.config.recovery?.enabled === false) {
      return 0;
    }
    this.recoveryStats.attempts += 1;
    const recovery = await this.recoveryCoordinator.attemptDependencyRecovery({
      blockedTasks: blocked,
      graph: taskGraph,
      completed,
      persistedTasks: this.tasks,
      milestoneId: milestone?.id,
      stateProbe: this.stateProbe,
      projectRoot: this.projectRoot,
      goalInvariant: this.goalInvariant,
    });
    if (Array.isArray(recovery.decisions) && recovery.decisions.length > 0) {
      this.recoveryStats.decisions.push(...recovery.decisions.slice(0, 20));
      this.recoveryStats.replanned_tasks += recovery.decisions.filter(
        (item) => item.action === 'probe_replan',
      ).length;
    }
    const recoveredCount = recovery.recovered_task_ids?.length || 0;
    this.recoveryStats.recovered_tasks += recoveredCount;
    return recoveredCount;
  }

  _buildGoalInvariant(plan) {
    const project = plan?.project || {};
    const summary = [project.name, project.description, plan?.requirement]
      .filter((v) => typeof v === 'string' && v.trim().length > 0)
      .join(' | ')
      .substring(0, 240);
    return {
      summary: summary || '保持原始业务目标不变',
      created_at: new Date().toISOString(),
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

  _extractReviewOutcome(reviewResult) {
    if (!reviewResult) {
      return { ok: false, error: 'Review result missing', error_code: REVIEW_ERROR_CODES.API_ERROR };
    }
    if (reviewResult.status === 'failed' || reviewResult.success === false) {
      return {
        ok: false,
        error:
          reviewResult.error_readable ||
          reviewResult.output?.error_readable ||
          reviewResult.error ||
          reviewResult.output?.summary ||
          'Review failed',
        error_code: reviewResult.error_code || reviewResult.output?.error_code || REVIEW_ERROR_CODES.API_ERROR,
      };
    }
    const score = reviewResult.output?.score;
    if (typeof score !== 'number') {
      return {
        ok: false,
        error: 'Review output missing score',
        error_code: REVIEW_ERROR_CODES.INVALID_SCHEMA,
      };
    }
    return {
      ok: true,
      score,
      issues: reviewResult.output?.issues || [],
      comments: reviewResult.output?.summary || reviewResult.output?.comments || '',
    };
  }

  _countCriticalIssues(issues = []) {
    return (issues || []).filter((issue) => String(issue?.severity || '').toUpperCase() === 'CRITICAL')
      .length;
  }

  _buildFixTaskQueue(issues = []) {
    const severityWeight = { CRITICAL: 3, WARNING: 2, INFO: 1 };
    return [...(issues || [])]
      .map((issue) => ({
        ...issue,
        _weight: severityWeight[String(issue?.severity || 'INFO').toUpperCase()] || 1,
      }))
      .sort((a, b) => b._weight - a._weight)
      .map(({ _weight, ...rest }) => rest);
  }

  async _attachFileHashes(codeResult) {
    if (!codeResult?.output) {
      return codeResult;
    }
    const changedFiles = [
      ...(codeResult.output.files_created || []),
      ...(codeResult.output.files_modified || []),
    ];
    const uniqueFiles = [...new Set(changedFiles)];
    const hashes = {};
    for (const file of uniqueFiles) {
      const fullPath = this._resolveProjectFilePath(file);
      if (!fullPath) {
        hashes[file] = null;
        continue;
      }
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        hashes[file] = typeof content === 'string' ? this._hashContent(content) : null;
      } catch {
        hashes[file] = null;
      }
    }
    codeResult.output.file_hashes = hashes;
    return codeResult;
  }

  _hashContent(content) {
    return createHash('sha256').update(String(content)).digest('hex');
  }

  _hasEffectiveFileChange(previousCodeResult, nextCodeResult) {
    const before = new Set([
      ...(previousCodeResult?.output?.files_created || []),
      ...(previousCodeResult?.output?.files_modified || []),
    ]);
    const after = new Set([
      ...(nextCodeResult?.output?.files_created || []),
      ...(nextCodeResult?.output?.files_modified || []),
    ]);
    if (after.size === 0) {
      return false;
    }
    for (const item of after) {
      if (!before.has(item)) {
        return true;
      }
    }

    const beforeHashes = previousCodeResult?.output?.file_hashes || {};
    const afterHashes = nextCodeResult?.output?.file_hashes || {};
    let comparableCount = 0;

    for (const item of after) {
      if (!before.has(item)) continue;
      const beforeHash = beforeHashes[item];
      const afterHash = afterHashes[item];
      if (typeof beforeHash === 'string' && typeof afterHash === 'string') {
        comparableCount += 1;
        if (beforeHash !== afterHash) {
          return true;
        }
      }
    }

    if (comparableCount > 0) {
      return false;
    }
    return false;
  }

  _buildHumanHandoffResult(task, payload) {
    return {
      task_id: task.id,
      status: 'needs_human',
      phase: 'handoff',
      stop_reason: payload.stopReason,
      cycles: payload.cycle || 0,
      score: payload.reviewScore || 0,
      issues: payload.reviewIssues || [],
      comments: payload.reviewComments || '',
      code_result: payload.codeResult,
      quality_metrics: payload.qualityMetrics || {},
      handoff: {
        stop_reason: payload.stopReason,
        evidence: payload.evidence || {},
        last_suggestion: payload.reviewComments || '',
        actions: ['人工检查关键问题', '确认是否继续自动修复', '必要时调整阈值后重试'],
      },
    };
  }

  _buildFixPrompt(task, codeResult, reviewResult, reviewComments, fixTaskQueue = []) {
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
    const prioritizedFixes =
      fixTaskQueue.length > 0
        ? `\n差异化补丁任务队列(按优先级执行，避免全文重写):\n${fixTaskQueue
            .slice(0, 8)
            .map(
              (issue, i) =>
                `${i + 1}. [${issue.severity || 'INFO'}] 文件:${issue.file || 'unknown'} | 问题:${issue.title || '未命名问题'} | 建议:${issue.suggestion || '按评审意见修复'}`,
            )
            .join('\n')}\n`
        : '';

    return `修正以下代码中的问题：

任务: ${task.description}

需修正的问题:
${issueList}
${prioritizedFixes}

${reviewComments ? `评审原话: "${reviewComments}"` : ''}

请根据以上问题修改代码，确保：
1. 所有 CRITICAL 问题必须修复
2. 所有 WARNING 问题尽量修复
3. 保持原有功能不变
4. 仅提交必要差异，禁止无关文件重写

修改后确保代码通过质量检查。`;
  }

  _buildRollbackRefixPrompt(task, issues = [], reviewComments = '') {
    const issueLines = (issues || [])
      .slice(0, 6)
      .map((issue, i) => `${i + 1}. [${issue.severity || 'INFO'}] ${issue.title || '未命名问题'} (${issue.file || 'unknown'})`)
      .join('\n');
    return `你上一次修复收益不足，系统已回滚相关文件。请进行更小粒度的二次修复：

任务: ${task.description}

二次修复清单:
${issueLines || '- 按评审意见进行小范围补丁修复'}

要求：
1. 仅修改必要行，避免大段重写
2. 优先解决重复出现的问题
3. 保持接口与行为兼容`;
  }

  _emitAlert(rule, severity = 'warning', details = {}) {
    const normalizedDetails = {
      ...details,
      error_code: details.error_code || null,
      error_category: details.error_category || this._inferAlertCategory(rule, details),
      error_readable: details.error_readable || null,
    };
    const alert = {
      timestamp: new Date().toISOString(),
      rule,
      severity,
      details: normalizedDetails,
    };
    this.alerts.push(alert);
    this.emit('engine:alert', alert);
    this._log('WARN', `[ALERT] ${rule}: ${JSON.stringify(normalizedDetails)}`);
    return alert;
  }

  _inferAlertCategory(rule, details = {}) {
    if (details?.error_category) {
      return details.error_category;
    }
    if (rule.includes('PARSE')) return 'parse';
    if (rule.includes('RETRY')) return 'retry';
    if (rule.includes('DIMINISH') || rule.includes('SOFT_STOP')) return 'convergence';
    if (rule.includes('LONG_RUNNING')) return 'runtime';
    return 'general';
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
    const failedRaw = results.filter((r) => r.status === 'failed').length;
    const blocked = results.filter((r) => r.status === 'blocked').length;
    const deadlock = results.filter((r) => r.status === 'deadlock').length;
    const failed = failedRaw + blocked + deadlock;
    const needsHuman = results.filter((r) => r.status === 'needs_human').length;
    const totalCycles = results.reduce((sum, r) => sum + (r.cycles || 0), 0);
    const avgScore = results.reduce((sum, r) => sum + (r.score || 0), 0) / (results.length || 1);
    const diminishingAbort = results.filter((r) => r.stop_reason === 'DIMINISHING_RETURNS').length;
    const successBase = done || 1;
    const total = results.length || 1;

    const summary = {
      total: results.length,
      done,
      failed,
      blocked,
      deadlock,
      needs_human: needsHuman,
      total_review_cycles: totalCycles,
      average_score: Math.round(avgScore),
      convergence_rate: done / total,
      avg_cycles: totalCycles / total,
      diminishing_abort_rate: diminishingAbort / total,
      tokens_per_success_task: this.tokenUsage.total / successBase,
      wasted_token_ratio: (failed + needsHuman) / total,
      duration_ms: Date.now() - startTime,
    };
    if (this.abStats.enabled) {
      summary.ab_test = {
        mode: this.abStats.mode,
        total_compares: this.abStats.total_compares,
        divergence_count: this.abStats.divergence_count,
        divergence_rate:
          this.abStats.total_compares > 0
            ? this.abStats.divergence_count / this.abStats.total_compares
            : 0,
        samples: this.abStats.samples,
      };
    }
    const repeatRates = results
      .map((r) => r.quality_metrics?.repeat_issue_rate)
      .filter((v) => typeof v === 'number');
    const clearanceTimes = results
      .map((r) => r.quality_metrics?.critical_clearance_time)
      .filter((v) => typeof v === 'number');
    summary.repeat_issue_rate =
      repeatRates.length > 0 ? repeatRates.reduce((a, b) => a + b, 0) / repeatRates.length : 0;
    summary.critical_clearance_time =
      clearanceTimes.length > 0
        ? clearanceTimes.reduce((a, b) => a + b, 0) / clearanceTimes.length
        : null;

    if (this.alerts.length > 0) {
      summary.alert_count = this.alerts.length;
      summary.alert_tail = this.alerts.slice(-10);
      summary.alert_by_rule = this.alerts.reduce((acc, alert) => {
        acc[alert.rule] = (acc[alert.rule] || 0) + 1;
        return acc;
      }, {});
      summary.alert_by_category = this.alerts.reduce((acc, alert) => {
        const category = alert.details?.error_category || 'general';
        acc[category] = (acc[category] || 0) + 1;
        return acc;
      }, {});
    }
    if (this.featureFlagAudit.length > 0) {
      summary.feature_flag_audit_count = this.featureFlagAudit.length;
      summary.feature_flag_audit_tail = this.featureFlagAudit.slice(-5);
    }
    summary.recovery = {
      attempts: this.recoveryStats.attempts,
      recovered_tasks: this.recoveryStats.recovered_tasks,
      replanned_tasks: this.recoveryStats.replanned_tasks,
      decisions_tail: this.recoveryStats.decisions.slice(-10),
    };
    return summary;
  }

  _log(level, message) {
    const entry = { timestamp: new Date().toISOString(), level, message };
    this.logs.push(entry);
    if (this.config.observability?.structured_json_logs) {
      console.log(JSON.stringify({ type: 'engine_log', ...entry }));
      return;
    }
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
