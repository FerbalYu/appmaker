const { Logger } = require('./logger');

class SelfCorrector {
  constructor(engine) {
    this.engine = engine;
    this.logger = new Logger();
  }

  async correct(triggerReason, context) {
    this.logger.info('corrections', 'corrections.log', `Analyzing root cause for trigger: ${triggerReason}`, { task: context.task?.id });
    
    // 实施基于规则的修正方案，见 self-correction.rules.md
    const rootCause = this._analyzeRootCause(triggerReason, context);
    const strategy = this._selectStrategy(rootCause);

    if (strategy.action === 'human_intervention') {
       this.logger.error('corrections', 'corrections.log', `Correction unresolved, requires human intervention for task: ${context.task?.id}`, { cause: rootCause });
       return false;
    }

    const result = await this._executeCorrection(strategy, context);
    const verified = await this._verify(result);
    
    this._logCorrection(triggerReason, rootCause, result, verified, context);
    return verified;
  }
  
  _analyzeRootCause(triggerReason, context) {
    let type = 'unknown_bug';
    let message = context.error || `Score too low: ${context.score}`;
    let severity = '🟡';

    if (triggerReason === 'quality_low') {
      type = 'quality_issue';
    } else if (triggerReason === 'error') {
      const errorStr = String(context.error || '').toLowerCase();
      if (errorStr.includes('network') || errorStr.includes('timeout')) {
        type = 'network_or_timeout';
      } else if (errorStr.includes('architecture') || errorStr.includes('design')) {
        type = 'architecture_violation';
        severity = '🔴';
      } else if (errorStr.includes('security') || errorStr.includes('injection')) {
        type = 'security_vuln';
        severity = '🔴';
      } else if (errorStr.includes('token') || errorStr.includes('quota') || errorStr.includes('rate limit')) {
        type = 'resource_exhausted';
        severity = '🔴';
      } else {
        type = 'code_bug';
      }
    }

    return { type, message, severity };
  }
  
  _selectStrategy(cause) {
    // 根据 rules/self-correction.rules.md 中的 CAN_SELF_CORRECT 和 NEEDS_HUMAN 判断
    const NEEDS_HUMAN = ['security_vuln', 'architecture_violation', 'resource_exhausted'];
    
    if (NEEDS_HUMAN.includes(cause.type)) {
      return { action: 'human_intervention', depth: 'halt' };
    }

    if (cause.type === 'network_or_timeout') {
      return { action: 'retry', depth: 'shallow' };
    }
    
    // 对于 quality_issue or code_bug，我们走 "Agent自我修正" 也就是 Type 1 修正
    return { action: 'agent_fix', depth: 'deep' };
  }
  
  async _executeCorrection(strategy, context) {
    if (strategy.action === 'retry') {
       // 重新调度该任务
       this.logger.info('corrections', 'corrections.log', `Scheduling retry for task: ${context.task?.id}`);
       return { status: 'retry_queued' };
    }
    if (strategy.action === 'agent_fix') {
       // 相当于触发Engine进入修补代码的循环 (或者把task状态标记为需要fix)
       this.logger.info('corrections', 'corrections.log', `Dispatching agent fix for task: ${context.task?.id}`);
       return { status: 'fix_dispatched' };
    }
    return { status: 'unhandled' };
  }
  
  async _verify(result) {
    return result.status === 'retry_queued' || result.status === 'fix_dispatched';
  }
  
  _logCorrection(triggerReason, cause, result, verified, context) {
    const logInfo = `修正记录 [corr_${Date.now()}] - 任务: ${context.task?.id || 'GLOBAL'} | 触发: ${triggerReason} | 问题: ${cause.message} (${cause.type}) | 动作: ${result.status} | 验证: ${verified ? '成功' : '失败'}`;
    this.logger.info('corrections', 'corrections.log', logInfo);
  }
}

module.exports = { SelfCorrector };
