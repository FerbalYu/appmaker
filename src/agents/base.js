/**
 * Agent Adapter 基类
 * 定义 Agent 调用的标准接口
 */

export class AgentAdapter {
  constructor(config) {
    this.config = config;
    this.name = config.name;
    this.type = config.type;
  }

  /**
   * 执行任务
   * @param {Object} task - 任务描述
   * @param {string} task.id - 任务 ID
   * @param {string} task.description - 任务描述
   * @param {string[]} task.files - 相关文件列表
   * @param {Object} task.context - 额外上下文
   * @returns {Promise<Object>} 执行结果
   */
  async execute(task) {
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * 验证 Agent 是否可用
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    throw new Error('healthCheck() must be implemented by subclass');
  }

  /**
   * 获取 Agent 元信息
   * @returns {Object}
   */
  getInfo() {
    return {
      name: this.name,
      type: this.type,
      capabilities: this.capabilities || []
    };
  }

  /**
   * 标准化错误处理
   * @param {Error} error
   * @returns {Object}
   */
  handleError(error) {
    return {
      success: false,
      error: {
        type: error.name,
        message: error.message,
        stack: error.stack
      },
      agent: this.name,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Agent 执行结果标准格式
 */
export const RESULT_FORMAT = {
  task_id: 'string',
  agent: 'string',
  status: 'success | failed | partial',
  output: {
    files_created: [],
    files_modified: [],
    tests_run: false,
    summary: 'string'
  },
  metrics: {
    duration_ms: 0,
    tokens_used: 0
  },
  errors: []
};
