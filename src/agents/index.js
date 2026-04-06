/**
 * Agent 系统主入口
 * 统一导出所有 Agent 相关功能
 */

export { AgentAdapter, RESULT_FORMAT } from './base.js';
export { NativeCoderAdapter } from './native-coder.js';
export { NativeReviewerAdapter } from './native-reviewer.js';
export { RainmakerAdapter } from './rainmaker.js';
export { AgentDispatcher, TASK_TYPE_MAPPING } from './dispatcher.js';

import { AgentDispatcher } from './dispatcher.js';
import { NativeCoderAdapter } from './native-coder.js';
import { NativeReviewerAdapter } from './native-reviewer.js';
import { AssetScoutAdapter } from './asset-scout.js';
import { RainmakerAdapter } from './rainmaker.js';
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
    ...(config.agents?.['native-reviewer'] || {}),
    ...(config.agents?.['native-coder'] || {}),
    ...overrideConfig,
  };
  const dispatcher = new AgentDispatcher(finalConfig);

  dispatcher.registerAgent('native-coder', () =>
    new NativeCoderAdapter({
      ...config.agents?.['native-coder'],
      ...overrideConfig,
    }),
  );
  dispatcher.registerAgent('native-reviewer', () =>
    new NativeReviewerAdapter({
      ...config.agents?.['native-reviewer'],
      ...overrideConfig,
    }),
  );
  dispatcher.registerAgent('asset-scout', () =>
    new AssetScoutAdapter({
      ...config.agents?.['asset-scout'],
      ...overrideConfig,
    }),
  );
  dispatcher.registerAgent('rainmaker', () =>
    new RainmakerAdapter({
      ...config.agents?.rainmaker,
      ...overrideConfig,
    }),
  );

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
