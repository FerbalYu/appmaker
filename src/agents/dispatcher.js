/**
 * Agent Dispatcher - 智能任务调度器
 * 
 * 核心能力：
 * - 基于任务类型的智能 Agent 选择
 * - 并发控制与负载均衡
 * - 自动重试与超时处理
 * - 请求队列管理
 */

import { NativeCoderAdapter } from './native-coder.js';
import { NativeReviewerAdapter } from './native-reviewer.js';

export const TASK_TYPE_MAPPING = {
  create: 'native-coder',
  modify: 'native-coder',
  crud: 'native-coder',
  template: 'native-coder',
  simple: 'native-coder',
  architect: 'native-coder',
  design: 'native-coder',
  complex: 'native-coder',
  analysis: 'native-coder',
  debug: 'native-coder',
  refactor: 'native-coder',
  coordinate: 'native-coder',
  auth: 'native-coder',
  security: 'native-coder',
  api: 'native-coder',
  integration: 'native-coder',
  fix: 'native-coder',
  review: 'native-reviewer',
  test: 'native-reviewer',
  docs: 'native-reviewer',
  document: 'native-reviewer'
};

export class AgentDispatcher {
  constructor(config = {}) {
    this.agents = new Map();
    this.config = {
      max_concurrent: 3,
      request_timeout: 300000,
      max_retries: 2,
      retry_delay: 1000,
      enable_queue: true,
      ...config
    };
    
    this.activeTasks = 0;
    this.taskQueue = [];
    this.taskMetrics = new Map();
  }

  registerAgent(name, adapter) {
    this.agents.set(name, adapter);
    this.taskMetrics.set(name, {
      totalTasks: 0,
      successTasks: 0,
      failedTasks: 0,
      totalTokens: 0,
      avgDuration: 0
    });
  }

  unregisterAgent(name) {
    this.agents.delete(name);
    this.taskMetrics.delete(name);
  }

  /**
   * 调度任务到合适的 Agent
   * @param {Object} task
   * @returns {Promise<Object>}
   */
  async dispatch(task) {
    const agentType = this._selectAgent(task);
    const agent = this.agents.get(agentType);

    if (!agent) {
      throw new Error(`Unknown agent type: ${agentType}`);
    }

    if (agentType === 'parallel') {
      return this._dispatchParallel(task);
    }

    const enrichedTask = this._enrichTask(task, agentType);
    const startTime = Date.now();

    await this._waitForSlot();

    try {
      this.activeTasks++;
      this._updateAgentMetrics(agentType, 'start');

      const result = await this._executeWithTimeout(
        agent.execute(enrichedTask),
        this.config.request_timeout,
        agentType,
        task.id
      );

      const duration = Date.now() - startTime;
      this._updateAgentMetrics(agentType, 'success', 0, duration);
      
      return {
        ...result,
        selected_agent: agentType,
        execution_time: duration
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this._updateAgentMetrics(agentType, 'failed', 0, duration);
      
      throw this._normalizeError(error, agentType, task.id);
    } finally {
      this.activeTasks--;
      this._processQueue();
    }
  }

  /**
   * 带超时的任务执行
   * @private
   */
  async _executeWithTimeout(promise, timeout, agentType, taskId) {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`[${agentType}] Task ${taskId} execution timeout (${timeout / 1000}s)`));
      }, timeout);
    });

    return Promise.race([promise, timeoutPromise]);
  }

  /**
   * 规范化错误信息
   * @private
   */
  _normalizeError(error, agentType, taskId) {
    const errorMsg = error?.message || String(error);
    
    if (errorMsg.includes('timeout')) {
      return new Error(`[${agentType}] Task ${taskId} timed out after ${this.config.request_timeout / 1000}s`);
    }
    
    if (errorMsg.includes('rate limit') || errorMsg.includes('429')) {
      return new Error(`[${agentType}] Rate limit exceeded for task ${taskId}. Please retry later.`);
    }
    
    return new Error(`[${agentType}] Task ${taskId} failed: ${errorMsg}`);
  }

  /**
   * 并行调度多个独立编程任务
   * @private
   */
  async _dispatchParallel(task) {
    const agent = this.agents.get('native-coder');
    const tasks = task.tasks || [];
    
    const promises = tasks.map(t => {
      const enrichedTask = this._enrichTask(t, 'native-coder');
      return this._executeWithTimeout(
        agent.execute(enrichedTask),
        this.config.request_timeout,
        'native-coder',
        t.id
      );
    });

    const results = await Promise.allSettled(promises);

    return {
      status: 'parallel',
      results: results.map((r, i) => ({
        task_id: tasks[i].id,
        ...(r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason?.message || r.reason })
      }))
    };
  }

  /**
   * 根据任务特征选择 Agent
   * @private
   */
  _selectAgent(task) {
    const { type, description } = task;

    if (task.agent) return task.agent;

    if (type && TASK_TYPE_MAPPING[type]) return TASK_TYPE_MAPPING[type];

    const desc = (description || '').toLowerCase();

    const reviewKeywords = ['review', '评审', '检查', '批评', 'critique', '评分', '代码审查'];
    if (reviewKeywords.some(k => desc.includes(k))) return 'native-reviewer';

    const codeKeywords = [
      'implement', '实现', 'create', '创建', 'write', '写',
      'fix', '修复', 'bug', 'add', '删除', '修改', '编写',
      '功能', 'feature', 'module', '模块', '开发', 'dev'
    ];
    if (codeKeywords.some(k => desc.includes(k))) return 'native-coder';

    return 'native-coder';
  }

  _enrichTask(task, agentType) {
    return {
      ...task,
      _dispatched_at: new Date().toISOString(),
      _agent_type: agentType,
      context: {
        ...task.context,
        agent_id: task.id,
        dispatcher: 'agent-dispatcher',
        checkpoint: task.checkpoint || this.config.checkpoint
      }
    };
  }

  async _waitForSlot() {
    while (this.activeTasks >= this.config.max_concurrent) {
      await this._delay(100);
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _processQueue() {
    if (this.config.enable_queue && this.taskQueue.length > 0) {
      const nextTask = this.taskQueue.shift();
      this.dispatch(nextTask).catch(err => {
        console.error(`Queue task ${nextTask.id} failed:`, err.message);
      });
    }
  }

  /**
   * 更新 Agent 指标
   * @private
   */
  _updateAgentMetrics(agentType, event, tokens = 0, duration = 0) {
    const metrics = this.taskMetrics.get(agentType);
    if (!metrics) return;

    metrics.totalTasks++;
    
    if (event === 'success') {
      metrics.successTasks++;
      metrics.totalTokens += tokens;
      metrics.avgDuration = (metrics.avgDuration * (metrics.successTasks - 1) + duration) / metrics.successTasks;
    } else if (event === 'failed') {
      metrics.failedTasks++;
    }
  }

  async healthCheck() {
    const results = {};
    for (const [name, agent] of this.agents) {
      try {
        const health = await Promise.race([
          agent.healthCheck(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 5000))
        ]);
        results[name] = { status: 'healthy', ...health };
      } catch (error) {
        results[name] = { status: 'unhealthy', error: error.message };
      }
    }
    return results;
  }

  getAgentsInfo() {
    const info = {};
    for (const [name, agent] of this.agents) {
      info[name] = {
        ...agent.getInfo(),
        metrics: this.taskMetrics.get(name),
        active_tasks: this.activeTasks,
        queue_length: this.taskQueue.length
      };
    }
    return info;
  }

  getMetrics() {
    const metrics = {};
    for (const [name, data] of this.taskMetrics) {
      metrics[name] = {
        ...data,
        success_rate: data.totalTasks > 0 ? (data.successTasks / data.totalTasks * 100).toFixed(2) + '%' : '0%'
      };
    }
    return {
      activeTasks: this.activeTasks,
      queueLength: this.taskQueue.length,
      agents: metrics
    };
  }

  configure(agentName, config) {
    const agent = this.agents.get(agentName);
    if (agent) {
      Object.assign(agent.config, config);
    }
  }

  /**
   * 停止所有 Agent
   */
  async shutdown() {
    for (const [name, agent] of this.agents) {
      if (typeof agent.shutdown === 'function') {
        await agent.shutdown();
      }
    }
    this.taskQueue = [];
  }
}
