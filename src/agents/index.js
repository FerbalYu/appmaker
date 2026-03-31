/**
 * Agent 系统主入口
 * 统一导出所有 Agent 相关功能
 */

export { AgentAdapter, RESULT_FORMAT } from './base.js';
export { OpenCodeAdapter } from './opencode.js';
export { ClaudeCodeAdapter } from './claude-code.js';
export { AgentDispatcher, TASK_TYPE_MAPPING } from './dispatcher.js';

import { AgentDispatcher } from './dispatcher.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { OpenCodeAdapter } from './opencode.js';
import { ExecutionEngine } from '../engine.js';
import { Planner } from '../planner.js';
import { config } from '../../config/index.js';

/**
 * 创建 Agent Dispatcher 实例
 * @param {Object} overrideConfig
 * @returns {AgentDispatcher}
 */
export function createDispatcher(overrideConfig = {}) {
  const finalConfig = {
    ...config.dispatcher,
    ...(config.agents?.opencode || {}),
    ...(config.agents?.['claude-code'] || {}),
    ...overrideConfig
  };
  const dispatcher = new AgentDispatcher(finalConfig);

  dispatcher.registerAgent('claude-code', new ClaudeCodeAdapter({
    ...config.agents?.['claude-code'],
    ...overrideConfig
  }));
  dispatcher.registerAgent('opencode', new OpenCodeAdapter({
    ...config.agents?.opencode,
    ...overrideConfig
  }));

  return dispatcher;
}

/**
 * 快速调度一个任务
 */
export async function dispatch(task) {
  const dispatcher = createDispatcher();
  return dispatcher.dispatch(task);
}

/**
 * 快速并行调度多个任务
 */
export async function dispatchParallel(tasks) {
  const dispatcher = createDispatcher();
  return dispatcher.dispatch({ type: 'parallel', tasks });
}

/**
 * 健康检查所有 Agent
 */
export async function healthCheck() {
  const dispatcher = createDispatcher();
  return dispatcher.healthCheck();
}

/**
 * 工厂函数
 */
export const createEngine = (cfg) => new ExecutionEngine(cfg);
export const createPlanner = (cfg) => new Planner(cfg);

export { ExecutionEngine, Planner, config };
