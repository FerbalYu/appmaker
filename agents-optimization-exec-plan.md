# Agents 优化执行计划（非安全项）

更新时间: 2026-04-06
状态: 进行中

## 目标范围
- 仅做非安全方向优化（调度、稳定性、可观测性、性能、可维护性）
- 每完成一个任务立即更新本文件的勾选状态和执行记录

## 任务清单与完成度
- [x] 1. Dispatcher 并发与队列机制重构
  - [x] 1.1 让并行任务走统一并发槽位控制（不绕过 `max_concurrent`）
  - [x] 1.2 去掉 busy-wait，改为事件驱动的槽位分配
  - [x] 1.3 落实 `max_retries/retry_delay` 的重试机制
  - [x] 1.4 失败分类与指标补充（重试次数、最终失败原因）
- [x] 2. UniversalToolbox 输入校验与错误标准化
  - [x] 2.1 增加统一参数校验入口
  - [x] 2.2 错误对象标准化（字段一致）
  - [x] 2.3 修复 `searchInDir` 正则状态问题
- [x] 3. NativeCoder 输出预算与变更检测优化
  - [x] 3.1 单工具输出和单轮输出预算治理
  - [x] 3.2 以工具写入记录为主的变更收集（扫描兜底）
  - [x] 3.3 trace 聚合统计字段补齐
- [x] 4. 回归验证与文档收尾
  - [x] 4.1 运行测试并记录结果
  - [x] 4.2 更新总结与后续建议

## 执行日志
- [2026-04-06 00:00] 初始化计划文档，待开始第 1 项（Dispatcher 重构）。
- [2026-04-06 00:01] 完成 `dispatcher.js` 第一轮重构：并行任务统一走槽位控制、`_waitForSlot` 改为 Promise 队列唤醒、新增 `_executeWithRetry` 并接入串行与并行执行路径。
- [2026-04-06 00:02] 完成 Dispatcher 指标补充：新增 `retriedTasks`、`retryAttempts`，并在成功/失败路径记录重试次数；第 1 大项全部完成。
- [2026-04-06 00:03] 完成 `universal-toolbox.js` 的 `searchInDir` 正则修复：去除 `g` 状态位，避免跨行 `test()` 时 `lastIndex` 导致漏匹配。
- [2026-04-06 00:04] 回归测试：执行 `bun test tests/agents.test.js`，结果 `19 pass / 0 fail`，通过。
- [2026-04-06 00:05] 完成 `universal-toolbox.js` 参数校验与错误标准化：新增 `_validateToolArgs`，在 `execute` 中统一返回 `error_info` 结构（`TOOL_NOT_FOUND` / `INVALID_TOOL_ARGS` / `TOOL_EXECUTION_FAILED`）。
- [2026-04-06 00:06] 回归测试：执行 `bun test tests/permission-toolbox.test.js`，结果 `22 pass / 0 fail`，通过。
- [2026-04-06 00:07] 完成 `native-coder.js` 输出预算与变更提示优化：新增 `MAX_TOOL_MESSAGE_CHARS`、`MAX_TOTAL_TOOL_MESSAGE_CHARS`，工具结果写入消息前统一预算截断；新增基于写工具的 `fileChangeHints`，优先使用提示结果，扫描作为兜底。
- [2026-04-06 00:08] 回归测试：执行 `bun test tests/agents.test.js`，结果 `19 pass / 0 fail`，通过。
- [2026-04-06 00:09] 完成 `native-coder.js` trace 聚合字段：在输出中新增 `trace_summary`（事件总数、错误数、串并行执行事件统计）。
- [2026-04-06 00:10] 回归测试：再次执行 `bun test tests/agents.test.js`，结果 `19 pass / 0 fail`，通过。
- [2026-04-06 00:11] 补充测试：`tests/agents.test.js` 新增 Dispatcher 重试指标、`trace_summary`、工具结果预算、变更提示优先路径测试。
- [2026-04-06 00:12] 补充测试：`tests/permission-toolbox.test.js` 新增 `error_info` 结构、参数类型校验、必填参数校验测试。
- [2026-04-06 00:13] 回归测试：执行 `bun test tests/agents.test.js tests/permission-toolbox.test.js`，结果 `48 pass / 0 fail`，通过。

## 阶段总结与后续建议
- 已完成：Dispatcher 并发/队列/重试/指标、UniversalToolbox 参数校验与错误标准化、NativeCoder 输出预算/变更提示/trace 汇总。
- 建议后续：为 `dispatcher` 与 `native-coder` 补充针对新指标字段与预算截断行为的单元测试，减少后续回归风险。
- 建议后续：将 `error_info` 与 `trace_summary` 接入上层监控或日志聚合，形成可观测闭环。
