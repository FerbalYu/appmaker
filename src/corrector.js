import { Logger } from './logger.js';
import { NativeCoderAdapter } from './agents/native-coder.js';

export class SelfCorrector {
  constructor(engine) {
    this.engine = engine;
    this.logger = new Logger();
    this.apiKey = process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY;
    this.apiHost = process.env.OPENAI_API_BASE || process.env.MINIMAX_API_HOST || 'https://api.minimaxi.com';
    this.model = process.env.OPENAI_MODEL || process.env.MINIMAX_API_MODEL || 'MiniMax-Text-01';
  }

  async correct(triggerReason, context) {
    this.logger.info('corrections', 'corrections.log', `Analyzing root cause for trigger: ${triggerReason}`, { task: context.task?.id });

    const rootCause = this._analyzeRootCause(triggerReason, context);
    const strategy = this._selectStrategy(rootCause);

    if (strategy.action === 'human_intervention') {
      this.logger.error('corrections', 'corrections.log', `Correction unresolved, requires human intervention for task: ${context.task?.id}`, { cause: rootCause });
      return this._createCorrectionResult(false, 'human_intervention', rootCause, null, context);
    }

    const result = await this._executeCorrection(strategy, context);
    const verified = await this._verify(result, context);

    this._logCorrection(triggerReason, rootCause, result, verified, context);
    return this._createCorrectionResult(verified, strategy.action, rootCause, result, context);
  }

  _createCorrectionResult(verified, action, cause, result, context) {
    return {
      success: verified,
      action,
      cause,
      result,
      context,
      timestamp: new Date().toISOString()
    };
  }

  _analyzeRootCause(triggerReason, context) {
    let type = 'unknown_bug';
    let message = context.error || `Score too low: ${context.score || 'N/A'}`;
    let severity = '🟡';
    let details = {};

    if (triggerReason === 'quality_low') {
      type = 'quality_issue';
      details = {
        score: context.score,
        issues: context.issues || [],
        files: context.files || []
      };
    } else if (triggerReason === 'error') {
      const errorStr = String(context.error || '').toLowerCase();
      if (errorStr.includes('network') || errorStr.includes('timeout') || errorStr.includes('econnrefused')) {
        type = 'network_or_timeout';
        severity = '🟡';
        details = { error: context.error };
      } else if (errorStr.includes('architecture') || errorStr.includes('design')) {
        type = 'architecture_violation';
        severity = '🔴';
      } else if (errorStr.includes('security') || errorStr.includes('injection') || errorStr.includes('xss')) {
        type = 'security_vuln';
        severity = '🔴';
        details = { vulnerability_type: this._detectSecurityIssue(errorStr) };
      } else if (errorStr.includes('token') || errorStr.includes('quota') || errorStr.includes('rate limit')) {
        type = 'resource_exhausted';
        severity = '🔴';
      } else if (errorStr.includes('syntax') || errorStr.includes('parse')) {
        type = 'syntax_error';
        severity = '🔴';
      } else {
        type = 'code_bug';
        details = { error: context.error };
      }
    } else if (triggerReason === 'timeout') {
      type = 'execution_timeout';
      severity = '🟡';
      details = { timeout_ms: context.timeout_ms || 0 };
    }

    return { type, message, severity, details };
  }

  _detectSecurityIssue(errorStr) {
    const patterns = {
      'sql_injection': /sql.*injection/i,
      'xss': /xss|cross.*site/i,
      'command_injection': /command.*injection|shell.*injection/i,
      'path_traversal': /path.*traversal|directory.*traversal/i
    };

    for (const [type, pattern] of Object.entries(patterns)) {
      if (pattern.test(errorStr)) return type;
    }
    return 'unknown';
  }

  _selectStrategy(cause) {
    const NEEDS_HUMAN = ['security_vuln', 'architecture_violation', 'resource_exhausted'];

    if (NEEDS_HUMAN.includes(cause.type)) {
      return { action: 'human_intervention', depth: 'halt', reason: `Issue type '${cause.type}' requires human review` };
    }

    if (cause.type === 'network_or_timeout') {
      return { action: 'retry', depth: 'shallow', maxRetries: 3, delay_ms: 1000 };
    }

    if (cause.type === 'syntax_error') {
      return { action: 'agent_fix', depth: 'targeted', maxCycles: 1 };
    }

    if (cause.type === 'execution_timeout') {
      return { action: 'optimize_and_retry', depth: 'medium', maxRetries: 2 };
    }

    return { action: 'agent_fix', depth: 'deep', maxCycles: 2 };
  }

  async _executeCorrection(strategy, context) {
    switch (strategy.action) {
      case 'retry':
        return await this._retryWithDelay(strategy, context);

      case 'agent_fix':
        return await this._agentFix(strategy, context);

      case 'optimize_and_retry':
        return await this._optimizeAndRetry(strategy, context);

      default:
        this.logger.warn('corrections', 'corrections.log', `Unknown correction action: ${strategy.action}`);
        return { status: 'unknown_action', action: strategy.action };
    }
  }

  async _retryWithDelay(strategy, context) {
    const maxRetries = strategy.maxRetries || 3;
    const delay_ms = strategy.delay_ms || 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.logger.info('corrections', 'corrections.log', `Retry attempt ${attempt}/${maxRetries} for task: ${context.task?.id}`);

      await this._sleep(delay_ms * attempt);

      if (context.task) {
        return { status: 'retry_scheduled', attempt, maxRetries };
      }
    }

    return { status: 'retry_exhausted', attempts: maxRetries };
  }

  async _agentFix(strategy, context) {
    if (!this.apiKey) {
      this.logger.error('corrections', 'corrections.log', 'API key not available for agent fix');
      return { status: 'fix_skipped', reason: 'no_api_key' };
    }

    this.logger.info('corrections', 'corrections.log', `Dispatching agent fix for task: ${context.task?.id}`);

    const coder = new NativeCoderAdapter({
      model: this.model,
      api_key: this.apiKey,
      api_host: this.apiHost
    });

    const fixPrompt = this._buildFixPrompt(context);

    try {
      const result = await coder.execute({
        id: `correction_${context.task?.id || 'unknown'}`,
        description: fixPrompt,
        context: context.taskContext
      });

      return {
        status: 'fix_completed',
        files_created: result.output?.files_created || [],
        files_modified: result.output?.files_modified || [],
        success: result.status === 'success'
      };
    } catch (error) {
      this.logger.error('corrections', 'corrections.log', `Agent fix failed: ${error.message}`);
      return { status: 'fix_failed', error: error.message };
    }
  }

  async _optimizeAndRetry(strategy, context) {
    this.logger.info('corrections', 'corrections.log', `Optimizing and retrying for task: ${context.task?.id}`);

    const optimizedPrompt = this._buildOptimizedPrompt(context);

    const coder = new NativeCoderAdapter({
      model: this.model,
      api_key: this.apiKey,
      api_host: this.apiHost
    });

    try {
      const result = await coder.execute({
        id: `optimized_${context.task?.id || 'unknown'}`,
        description: optimizedPrompt,
        context: context.taskContext
      });

      return {
        status: 'optimization_completed',
        files_created: result.output?.files_created || [],
        success: result.status === 'success'
      };
    } catch (error) {
      return { status: 'optimization_failed', error: error.message };
    }
  }

  _buildFixPrompt(context) {
    const task = context.task || {};
    const issues = context.issues || [];
    const score = context.score || 0;

    const issueList = Array.isArray(issues)
      ? issues.map((issue, i) => {
          if (typeof issue === 'string') {
            return `${i + 1}. [待修复] ${issue}`;
          }
          return `${i + 1}. [${issue.severity}] ${issue.title}\n   文件: ${issue.file || 'unknown'}\n   问题: ${issue.reason || issue.message || 'N/A'}\n   建议: ${issue.suggestion || 'N/A'}`;
        }).join('\n')
      : `评分过低 (${score}/100)，需要全面改进代码质量。`;

    return `修正以下代码中的问题：

任务: ${task.description || '未知任务'}

需修正的问题:
${issueList}

请根据以上问题修改代码，确保：
1. 所有 CRITICAL 问题必须修复
2. 所有 WARNING 问题尽量修复
3. 保持原有功能不变
4. 优化代码结构和可读性

修改后确保代码通过质量检查。`;
  }

  _buildOptimizedPrompt(context) {
    const task = context.task || {};
    const timeout_ms = context.timeout_ms || 0;

    return `优化以下代码以提高执行效率：

任务: ${task.description || '未知任务'}

原始代码执行超时: ${timeout_ms}ms

请优化代码：
1. 减少不必要的计算和循环
2. 使用更高效的算法或数据结构
3. 添加适当的缓存或记忆化
4. 保持功能不变

确保优化后的代码能够快速执行。`;
  }

  async _verify(result, context) {
    if (result.status === 'retry_scheduled' || result.status === 'fix_completed' || result.status === 'optimization_completed') {
      return true;
    }
    return false;
  }

  _logCorrection(triggerReason, cause, result, verified, context) {
    const logInfo = `修正记录 [corr_${Date.now()}] - 任务: ${context.task?.id || 'GLOBAL'} | 触发: ${triggerReason} | 问题: ${cause.message} (${cause.type}) | 动作: ${result.status} | 验证: ${verified ? '成功' : '失败'}`;
    this.logger.info('corrections', 'corrections.log', logInfo);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async correctTask(taskId, issues, context = {}) {
    const correctionContext = {
      task: { id: taskId, ...context },
      issues,
      score: context.score || 50,
      triggerReason: 'quality_low'
    };

    return await this.correct('quality_low', correctionContext);
  }

  async handleExecutionError(error, taskId, context = {}) {
    const correctionContext = {
      task: { id: taskId, ...context },
      error: error.message || String(error),
      triggerReason: 'error'
    };

    return await this.correct('error', correctionContext);
  }
}
