/**
 * Agent 系统主入口
 * 统一导出所有 Agent 相关功能
 */

const { AgentAdapter, RESULT_FORMAT } = require('./base');
const { OpenCodeAdapter } = require('./opencode');
const { ClaudeCodeAdapter } = require('./claude-code');
const { AgentDispatcher, TASK_TYPE_MAPPING } = require('./dispatcher');
const { ExecutionEngine } = require('../engine');
const { Planner } = require('../planner');

// 加载配置
const fs = require('fs');
const path = require('path');

let config = {};
const configPath = path.join(__dirname, '..', '..', 'config', 'agents.json');
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

/**
 * 创建 Agent Dispatcher 实例
 * @param {Object} overrideConfig - 可覆盖的配置
 * @returns {AgentDispatcher}
 */
function createDispatcher(overrideConfig = {}) {
  const finalConfig = {
    ...config.dispatcher,
    ...config.agents?.opencode,
    ...config.agents?.claude_code,
    ...overrideConfig
  };
  return new AgentDispatcher(finalConfig);
}

/**
 * 快速调度一个任务
 * @param {Object} task - 任务描述
 * @returns {Promise<Object>}
 */
async function dispatch(task) {
  const dispatcher = createDispatcher();
  return dispatcher.dispatch(task);
}

/**
 * 快速并行调度多个任务
 * @param {Object[]} tasks - 任务数组
 * @returns {Promise<Object>}
 */
async function dispatchParallel(tasks) {
  const dispatcher = createDispatcher();
  return dispatcher.dispatch({ type: 'parallel', tasks });
}

/**
 * 健康检查所有 Agent
 * @returns {Promise<Object>}
 */
async function healthCheck() {
  const dispatcher = createDispatcher();
  return dispatcher.healthCheck();
}

module.exports = {
  // 类
  AgentAdapter,
  OpenCodeAdapter,
  ClaudeCodeAdapter,
  AgentDispatcher,
  ExecutionEngine,
  Planner,

  // 常量
  RESULT_FORMAT,
  TASK_TYPE_MAPPING,

  // 工厂函数
  createDispatcher,
  createEngine: (config) => new ExecutionEngine(config),
  createPlanner: (config) => new Planner(config),
  dispatch,
  dispatchParallel,
  healthCheck,

  // 配置
  config
};
