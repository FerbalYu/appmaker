/**
 * Agent Dispatcher
 * claude-code 负责编程，opencode 负责毒舌点评
 */

import { OpenCodeAdapter } from './opencode.js';
import { ClaudeCodeAdapter } from './claude-code.js';

export const TASK_TYPE_MAPPING = {
  // ===== 编程任务 → claude-code =====
  'create': 'claude-code',
  'modify': 'claude-code',
  'crud': 'claude-code',
  'template': 'claude-code',
  'simple': 'claude-code',
  'architect': 'claude-code',
  'design': 'claude-code',
  'complex': 'claude-code',
  'analysis': 'claude-code',
  'debug': 'claude-code',
  'refactor': 'claude-code',
  'coordinate': 'claude-code',
  'auth': 'claude-code',
  'security': 'claude-code',
  'api': 'claude-code',
  'integration': 'claude-code',

  // ===== 评审任务 → opencode =====
  'review': 'opencode',
  'test': 'opencode',
  'docs': 'opencode',
  'document': 'opencode'
};

export class AgentDispatcher {
  constructor(config = {}) {
    this.agents = new Map();
    this.config = config;
    this.maxConcurrent = config.max_concurrent || 3;
    this.activeTasks = 0;
  }

  registerAgent(name, adapter) {
    this.agents.set(name, adapter);
  }

  unregisterAgent(name) {
    this.agents.delete(name);
  }

  /**
   * 调度任务到合适的 Agent
   * @param {Object} task
   * @returns {Promise<Object>}
   */
  async dispatch(task) {
    const agentType = this._selectAgent(task);

    if (agentType === 'parallel') {
      return this._dispatchParallel(task);
    }

    const agent = this.agents.get(agentType);
    if (!agent) {
      throw new Error(`Unknown agent type: ${agentType}`);
    }

    const enrichedTask = this._enrichTask(task, agentType);

    await this._waitForSlot();

    try {
      this.activeTasks++;
      const result = await agent.execute(enrichedTask);
      return { ...result, selected_agent: agentType };
    } finally {
      this.activeTasks--;
    }
  }

  /**
   * 并行调度多个独立编程任务
   * @private
   */
  async _dispatchParallel(tasks) {
    const agent = this.agents.get('claude-code');
    const promises = tasks.map(task => {
      const enrichedTask = this._enrichTask(task, 'claude-code');
      return agent.execute(enrichedTask);
    });

    const results = await Promise.allSettled(promises);

    return {
      status: 'parallel',
      results: results.map((r, i) => ({
        task_id: tasks[i].id,
        ...(r.status === 'fulfilled' ? r.value : { status: 'failed', error: r.reason })
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

    const reviewKeywords = ['review', '评审', '检查', '批评', 'critique'];
    if (reviewKeywords.some(k => desc.includes(k))) return 'opencode';

    const codeKeywords = [
      'implement', '实现', 'create', '创建', 'write', '写',
      'fix', '修复', 'bug', 'add', '删除', '修改',
      '功能', 'feature', 'module', '模块'
    ];
    if (codeKeywords.some(k => desc.includes(k))) return 'claude-code';

    return 'claude-code';
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
    while (this.activeTasks >= this.maxConcurrent) {
      await this._delay(100);
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async healthCheck() {
    const results = {};
    for (const [name, agent] of this.agents) {
      results[name] = await agent.healthCheck();
    }
    return results;
  }

  getAgentsInfo() {
    const info = {};
    for (const [name, agent] of this.agents) {
      info[name] = agent.getInfo();
    }
    return info;
  }

  configure(agentName, config) {
    const agent = this.agents.get(agentName);
    if (agent) Object.assign(agent.config, config);
  }
}
