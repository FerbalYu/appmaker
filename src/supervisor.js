/**
 * Supervisor - 执行监督与风险管理
 * 
 * 核心职责：
 * - 实时监控任务执行进度
 * - 收集和统计各项指标
 * - 评估风险等级并触发保护机制
 * - 协调 self-correction 修正流程
 */

import { Logger } from './logger.js';
import { SelfCorrector } from './corrector.js';
import { UniversalToolbox } from './agents/universal-toolbox.js';

const REVIEW_THRESHOLD = 85;

export class Supervisor {
  constructor(engine, config = {}) {
    this.engine = engine;
    this.logger = new Logger(config.logger);
    this.corrector = new SelfCorrector(engine);
    
    this.toolbox = new UniversalToolbox({
      workspace_root: config.workspace_root || process.cwd()
    });
    
    this.config = {
      maxTokens: 100000,
      maxErrors: 5,
      maxReviewCycles: 3,
      riskCheckInterval: 10000,
      ...config
    };

    this.metrics = {
      tasks: {},
      tokens: { coder: 0, reviewer: 0, total: 0 },
      errors: [],
      corrections: [],
      startTime: Date.now(),
      lastRiskCheck: Date.now()
    };

    this.riskLevel = 'LOW';
    this.lastReportTime = Date.now();
    this.reportInterval = 30000;

    this._setupEventListeners();
    this._startRiskMonitor();
  }

  /**
   * 设置事件监听器
   * @private
   */
  _setupEventListeners() {
    this.engine.on('task:start', (data) => this._onTaskStart(data));
    this.engine.on('task:done', (data) => this._onTaskDone(data));
    this.engine.on('task:error', (data) => this._onTaskError(data));
    this.engine.on('task:review', (data) => this._onTaskReview(data));
    this.engine.on('milestone:start', (data) => this._onMilestoneStart(data));
    this.engine.on('milestone:done', (data) => this._onMilestoneDone(data));
    this.engine.on('plan:done', (data) => this._onPlanDone(data));
    this.engine.on('budget:exceeded', (data) => this._onBudgetExceeded(data));
  }

  /**
   * 启动风险监控循环
   * @private
   */
  _startRiskMonitor() {
    this._riskMonitorInterval = setInterval(() => {
      this._periodicRiskCheck();
    }, this.config.riskCheckInterval);
  }

  /**
   * 停止风险监控
   */
  stop() {
    if (this._riskMonitorInterval) {
      clearInterval(this._riskMonitorInterval);
      this._riskMonitorInterval = null;
    }
  }

  /**
   * 使用工具更新任务状态
   */
  async updateTaskStatus(taskId, status) {
    const result = await this.toolbox.execute('task_update', {
      task_id: taskId,
      status
    });
    return result;
  }

  /**
   * 获取任务清单状态
   */
  async getTaskList() {
    return this.toolbox.execute('task_list', {});
  }

  /**
   * 使用工具发送消息给团队
   */
  async sendTeamMessage(agentId, message, priority = 'normal') {
    return this.toolbox.execute('send_message', {
      agent_id: agentId,
      message,
      priority
    });
  }

  _onTaskStart({ task }) {
    this.metrics.tasks[task.id] = {
      start: Date.now(),
      status: 'running',
      type: task.type,
      dependencies: task.dependencies || [],
      agent: task.agent
    };
    this.logger.info('execution', `task_${task.id}.log`, `🔄 Task ${task.id} started`, { type: task.type });
    this._emitPeriodicReport();
  }

  _onTaskDone({ task, result }) {
    const t = this.metrics.tasks[task.id] || {};
    t.end = Date.now();
    t.duration = t.end - t.start;
    t.status = result.status;
    t.score = result.score;
    t.cycles = result.cycles || 0;

    if (result.status === 'done') {
      t.status = 'done';
      this.logger.info('execution', `task_${task.id}.log`, `✅ Task ${task.id} finished`, { 
        duration: `${Math.round(t.duration / 1000)}s`, 
        score: result.score,
        cycles: result.cycles
      });
    } else if (result.status === 'needs_human') {
      t.status = 'needs_human';
      this.logger.warn('execution', `task_${task.id}.log`, `⚠️ Task ${task.id} needs human intervention`, { score: result.score });
    }

    const codeTokens = result.code_result?.metrics?.tokens_used || 0;
    const reviewTokens = result.review_result?.output?.metrics?.tokens_used || 0;
    this.metrics.tokens.coder += codeTokens;
    this.metrics.tokens.reviewer += reviewTokens;
    this.metrics.tokens.total += codeTokens + reviewTokens;

    this.assessRisk();
    this._emitPeriodicReport();
  }

  _onTaskError({ task, result }) {
    const errorEntry = {
      task: task.id,
      phase: result.phase,
      error: result.error,
      time: Date.now()
    };
    this.metrics.errors.push(errorEntry);

    this.logger.error('quality', `error_${task.id}.log`, `❌ Task error`, { 
      error: result.error, 
      phase: result.phase 
    });

    this.triggerCorrection('error', { task, error: result.error, phase: result.phase });
    this.assessRisk();
  }

  _onTaskReview({ task, result }) {
    const tokens = result.output?.metrics?.tokens_used || 0;
    this.metrics.tokens.reviewer += tokens;
    this.metrics.tokens.total += tokens;

    if (result.output?.score < REVIEW_THRESHOLD) {
      this.logger.warn('quality', `review_${task.id}.log`, `⚠️ Low review score for ${task.id} (${result.output?.score} < ${REVIEW_THRESHOLD})`, { score: result.output?.score });
      this.triggerCorrection('quality_low', { task, score: result.output?.score, issues: result.output?.issues || [] });
    }
  }

  _onMilestoneStart({ milestone }) {
    this.logger.info('execution', 'supervisor.log', `🏁 Milestone "${milestone.name}" started (${milestone.tasks?.length || 0} tasks)`);
  }

  _onMilestoneDone({ milestone }) {
    const tasks = this.metrics.tasks;
    const milestoneTaskIds = milestone.tasks || [];
    const completed = milestoneTaskIds.filter(id => tasks[id]?.status === 'done').length;
    const failed = milestoneTaskIds.filter(id => tasks[id]?.status === 'failed').length;
    
    this.logger.info('execution', 'supervisor.log', `✅ Milestone "${milestone.name}" complete! (${completed}/${milestoneTaskIds.length} tasks done, ${failed} failed)`);
    this.assessRisk();
  }

  _onPlanDone({ plan, summary }) {
    this.logger.info('execution', 'supervisor.log', `🎉 Plan execution complete!`);
    this.logger.info('execution', 'supervisor.log', `📊 Summary:`, summary);
    this.logger.info('execution', 'supervisor.log', `💰 Total tokens: ${this.metrics.tokens.total}`);
    
    this.stop();
    this._emitFinalReport(summary);
  }

  _onBudgetExceeded({ usage, budget }) {
    this.logger.error('execution', 'supervisor.log', `💸 Token budget exceeded! (${usage.total}/${budget})`);
    this.riskLevel = 'CRITICAL';
  }

  /**
   * 评估当前风险等级
   */
  assessRisk() {
    const { tokens, errors, tasks } = this.metrics;
    const totalTasks = Object.keys(tasks).length;
    const completedTasks = Object.values(tasks).filter(t => t.status === 'done').length;
    
    const tokenRatio = tokens.total / this.config.maxTokens;
    const errorRatio = errors.length / this.config.maxErrors;
    const completionRate = totalTasks > 0 ? completedTasks / totalTasks : 0;

    const previousRisk = this.riskLevel;

    if (tokenRatio > 0.95 || errorRatio > 1.0) {
      this.riskLevel = 'CRITICAL';
      this.engine.halt = true;
      if (this.riskLevel !== previousRisk) this.logger.error('execution', 'supervisor.log', '🚨 CRITICAL risk detected - execution halted');
    } else if (tokenRatio > 0.8 || errorRatio > 0.6) {
      this.riskLevel = 'HIGH';
      if (this.riskLevel !== previousRisk) this.logger.warn('execution', 'supervisor.log', `⚠️ HIGH risk - Tokens: ${Math.round(tokenRatio * 100)}%, Errors: ${errors.length}`);
    } else if (tokenRatio > 0.5 || errorRatio > 0.3) {
      this.riskLevel = 'MEDIUM';
      if (this.riskLevel !== previousRisk) this.logger.info('execution', 'supervisor.log', `🟡 MEDIUM risk - Tokens: ${Math.round(tokenRatio * 100)}%, Errors: ${errors.length}`);
    } else {
      this.riskLevel = 'LOW';
    }

    if (errors.length > this.config.maxErrors) {
      this.engine.halt = true;
      this.logger.error('execution', 'supervisor.log', `🚨 Error threshold exceeded (${errors.length}/${this.config.maxErrors}) - execution halted`);
    }

    return this.riskLevel;
  }

  /**
   * 定期风险检查
   * @private
   */
  _periodicRiskCheck() {
    this.metrics.lastRiskCheck = Date.now();
    
    if (this.engine.aborted) {
      this.riskLevel = 'ABORTED';
      this.stop();
      return;
    }

    const elapsed = Date.now() - this.metrics.startTime;
    if (elapsed > 3600000) {
      this.logger.warn('execution', 'supervisor.log', `⏰ Execution has been running for ${Math.round(elapsed / 60000)} minutes`);
    }

    this.assessRisk();
  }

  /**
   * 触发修正流程
   */
  async triggerCorrection(reason, context) {
    const correctionId = `corr_${Date.now()}`;
    
    this.logger.info('corrections', `${correctionId}.md`, `🔧 Triggering correction for ${context.task?.id}`, { reason });
    
    try {
      const result = await this.corrector.correct(reason, context);
      this.metrics.corrections.push({
        id: correctionId,
        reason,
        taskId: context.task?.id,
        result,
        timestamp: new Date().toISOString()
      });
      
      if (!result.success && result.action === 'human_intervention') {
        this.logger.error('corrections', 'supervisor.log', `⚠️ Correction failed - human intervention required for task ${context.task?.id}`);
      }
      
      return result;
    } catch (error) {
      this.logger.error('corrections', 'supervisor.log', `❌ Correction process error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 发出定期状态报告
   * @private
   */
  _emitPeriodicReport() {
    const now = Date.now();
    if (now - this.lastReportTime < this.reportInterval) return;
    
    this.lastReportTime = now;
    const { tasks, tokens, errors } = this.metrics;
    const totalTasks = Object.keys(tasks).length;
    const completedTasks = Object.values(tasks).filter(t => t.status === 'done').length;
    const failedTasks = Object.values(tasks).filter(t => t.status === 'failed').length;
    
    const riskIcon = { LOW: '🟢', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' }[this.riskLevel];
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[SUPERVISION REPORT] ${new Date().toLocaleString()}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`风险等级: ${riskIcon} ${this.riskLevel}`);
    console.log(`任务进度: ${completedTasks}/${totalTasks} 完成, ${failedTasks} 失败`);
    console.log(`Token 消耗: ${tokens.total} / ${this.config.maxTokens} (${Math.round(tokens.total / this.config.maxTokens * 100)}%)`);
    console.log(`错误累积: ${errors.length} / ${this.config.maxErrors}`);
    console.log(`${'='.repeat(60)}\n`);
  }

  /**
   * 发出最终报告
   * @private
   */
  _emitFinalReport(summary) {
    const { tokens, corrections } = this.metrics;
    const duration = Date.now() - this.metrics.startTime;
    
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[FINAL REPORT] 执行完成`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`📊 执行摘要:`);
    console.log(`   总任务: ${summary.total}`);
    console.log(`   ✅ 成功: ${summary.done}`);
    console.log(`   ❌ 失败: ${summary.failed}`);
    console.log(`   ⚠️ 需人工: ${summary.needs_human}`);
    console.log(`   🔄 修正次数: ${corrections.length}`);
    console.log(`   📈 平均评分: ${summary.average_score}`);
    console.log(`💰 Token 消耗:`);
    console.log(`   native-coder: ${tokens.coder}`);
    console.log(`   native-reviewer: ${tokens.reviewer}`);
    console.log(`   总计: ${tokens.total}`);
    console.log(`⏱️ 总耗时: ${Math.round(duration / 1000)}s`);
    console.log(`${'═'.repeat(60)}\n`);
  }

  /**
   * 获取当前指标
   */
  getMetrics() {
    return {
      ...this.metrics,
      riskLevel: this.riskLevel,
      config: this.config
    };
  }

  /**
   * 获取风险等级
   */
  getRiskLevel() {
    return this.riskLevel;
  }
}
