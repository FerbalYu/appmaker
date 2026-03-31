const { Logger } = require('./logger');
const { SelfCorrector } = require('./corrector');

class Supervisor {
  constructor(engine, config = {}) {
    this.engine = engine;
    this.logger = new Logger(config.logger);
    this.corrector = new SelfCorrector(engine);
    this.metrics = {
      tasks: {},
      tokens: { claude: 0, opencode: 0, total: 0 },
      errors: [],
      startTime: Date.now()
    };
    
    this.thresholds = config.thresholds || {
      maxTokens: 100000,
      maxErrors: 5
    };

    // 订阅 Engine 事件
    engine.on('task:start', (data) => this._onTaskStart(data));
    engine.on('task:done', (data) => this._onTaskDone(data));
    engine.on('task:error', (data) => this._onTaskError(data));
    engine.on('task:review', (data) => this._onTaskReview(data));
    engine.on('milestone:done', (data) => this._onMilestoneDone(data));
    engine.on('plan:done', (data) => this._onPlanDone(data));
  }

  _onTaskStart({ task }) {
    this.metrics.tasks[task.id] = { start: Date.now(), ...task };
    this.logger.info('execution', `task_${task.id}.log`, `Task ${task.id} started`, { type: task.type });
  }

  _onTaskDone({ task, result }) {
    const t = this.metrics.tasks[task.id] || {};
    t.end = Date.now();
    t.duration = t.end - t.start;
    t.status = result.status;
    
    // Accumulate tokens
    const tokens = result.code_result?.metrics?.tokens_used || 0;
    this.metrics.tokens.claude += tokens;
    this.metrics.tokens.total += tokens;

    this.logger.info('execution', `task_${task.id}.log`, `Task ${task.id} finished`, { duration: t.duration, status: result.status });
    this.assessRisk();
  }

  _onTaskError({ task, result, phase }) {
    this.metrics.errors.push({ task: task.id, phase, error: result.error, time: Date.now() });
    this.logger.error('quality', `error_${task.id}.log`, `Task error`, { error: result.error, phase });
    
    // 触发修正 (接入 SelfCorrector 逻辑入口)
    this.triggerCorrection('error', { task, error: result.error });
  }

  _onTaskReview({ task, result }) {
    const tokens = result.output?.metrics?.tokens_used || 0;
    this.metrics.tokens.opencode += tokens;
    this.metrics.tokens.total += tokens;

    if (result.output?.score < 60) {
      this.logger.warn('quality', `review_${task.id}.log`, `Low review score for ${task.id}`, { score: result.output?.score });
      this.triggerCorrection('quality_low', { task, score: result.output?.score });
    }
  }

  _onMilestoneDone({ milestone }) {
    this.logger.info(null, 'supervisor.log', `Milestone ${milestone.name} complete!`);
    this.assessRisk();
  }

  _onPlanDone({ plan, summary }) {
    this.logger.info(null, 'supervisor.log', `Plan execution complete! Total tokens: ${this.metrics.tokens.total}`, summary);
  }

  assessRisk() {
    if (this.metrics.tokens.total > this.thresholds.maxTokens) {
      this.logger.warn(null, 'supervisor.log', `[RISK] Token usage exceeds threshold! (${this.metrics.tokens.total} > ${this.thresholds.maxTokens})`);
      this.engine.halt = true; // Stop accepting new tasks
    }
    if (this.metrics.errors.length > this.thresholds.maxErrors) {
      this.logger.error(null, 'supervisor.log', `[RISK] Too many errors! (${this.metrics.errors.length}) Execution may be compromised.`);
      this.engine.halt = true; // Stop accepting new tasks
    }
  }

  async triggerCorrection(reason, context) {
    this.logger.info('corrections', `corr_${Date.now()}.md`, `Triggered correction for ${context.task.id}`, { reason });
    await this.corrector.correct(reason, context);
  }
}

module.exports = { Supervisor };
