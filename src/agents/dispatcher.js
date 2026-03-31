/**
 * Agent Dispatcher
 * claude-code 负责编程，opencode 负责毒舌点评
 */

const { OpenCodeAdapter } = require('./opencode');
const { ClaudeCodeAdapter } = require('./claude-code');

const TASK_TYPE_MAPPING = {
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
  'test': 'opencode',      // 测试评审
  'docs': 'opencode',      // 文档评审
  'document': 'opencode'
};

class AgentDispatcher {
  constructor(config = {}) {
    this.agents = new Map();
    this.config = config;
    this.maxConcurrent = config.max_concurrent || 3;
    this.activeTasks = 0;

    // 初始化 Agent
    this._initAgents();
  }

  /**
   * 初始化 Agent 实例
   * @private
   */
  _initAgents() {
    // OpenCode
    const opencodeConfig = {
      use_cli: this.config.opencode_use_cli ?? true,
      cli_path: this.config.opencode_cli_path || 'opencode',
      api_endpoint: this.config.opencode_api_endpoint || 'http://localhost:3000',
      timeout: this.config.opencode_timeout || 120000
    };
    this.agents.set('opencode', new OpenCodeAdapter(opencodeConfig));

    // Claude Code
    const claudeCodeConfig = {
      use_cli: this.config.claude_code_use_cli ?? true,
      cli_path: this.config.claude_code_cli_path || 'claude',
      api_endpoint: this.config.claude_code_api_endpoint || 'http://localhost:8080',
      timeout: this.config.claude_code_timeout || 300000,
      model: this.config.claude_model || 'claude-opus-4-6'
    };
    this.agents.set('claude-code', new ClaudeCodeAdapter(claudeCodeConfig));
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

    // 添加上下文
    const enrichedTask = this._enrichTask(task, agentType);

    // 等待槽位
    await this._waitForSlot();

    try {
      this.activeTasks++;
      const result = await agent.execute(enrichedTask);
      return {
        ...result,
        selected_agent: agentType
      };
    } finally {
      this.activeTasks--;
    }
  }

  /**
   * 并行调度多个独立编程任务
   * @private
   */
  async _dispatchParallel(tasks) {
    // 编程任务并行 → claude-code
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
   * 原则：claude-code 编程，opencode 评审
   * @private
   */
  _selectAgent(task) {
    const { type, description } = task;

    // 1. 显式指定
    if (task.agent) {
      return task.agent;
    }

    // 2. 根据类型映射
    if (type && TASK_TYPE_MAPPING[type]) {
      return TASK_TYPE_MAPPING[type];
    }

    // 3. 根据描述关键词判断
    const desc = (description || '').toLowerCase();

    // 评审关键词 → opencode
    const reviewKeywords = ['review', '评审', '检查', '批评', 'critique'];
    if (reviewKeywords.some(k => desc.includes(k))) {
      return 'opencode';
    }

    // 编程关键词 → claude-code
    const codeKeywords = [
      'implement', '实现', 'create', '创建', 'write', '写',
      'fix', '修复', 'bug', 'add', '删除', '修改',
      '功能', 'feature', 'module', '模块'
    ];
    if (codeKeywords.some(k => desc.includes(k))) {
      return 'claude-code';
    }

    // 4. 默认：编程任务 → claude-code
    return 'claude-code';
  }

  /**
   * 丰富任务上下文
   * @private
   */
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

  /**
   * 等待可用槽位
   * @private
   */
  async _waitForSlot() {
    while (this.activeTasks >= this.maxConcurrent) {
      await this._delay(100);
    }
  }

  /**
   * 延迟
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 健康检查所有 Agent
   */
  async healthCheck() {
    const results = {};
    for (const [name, agent] of this.agents) {
      results[name] = await agent.healthCheck();
    }
    return results;
  }

  /**
   * 获取 Agent 信息
   */
  getAgentsInfo() {
    const info = {};
    for (const [name, agent] of this.agents) {
      info[name] = agent.getInfo();
    }
    return info;
  }

  /**
   * 配置 Agent
   */
  configure(agentName, config) {
    const agent = this.agents.get(agentName);
    if (agent) {
      Object.assign(agent.config, config);
    }
  }
}

module.exports = { AgentDispatcher, TASK_TYPE_MAPPING };
