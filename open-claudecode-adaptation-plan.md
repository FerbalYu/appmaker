# Open-ClaudeCode 对标改造计划（Appmaker）

更新时间: 2026-04-07
状态: Round 3 Completed（R3-1/R3-3 已落地）

## 1. 背景

`appmaker` 已完成收敛控制面、评审门禁与解析器的基础改造，但在高压场景下仍存在以下问题：

- 重试策略仍偏“字符串匹配驱动”，精细度不够，易产生无效重试。
- 429/529 等容量类错误退避策略固定，无法充分利用服务端 `Retry-After` 信号。
- 可观测字段不足以直接回答“为什么重试/为什么放弃”。
- 局部场景下仍可能出现“高 token 低收益”的修复放大。

对标 `Open-ClaudeCode` 的目标不是复制实现，而是迁移其“策略化重试 + 收敛控制”思想。

## 2. 改造目标

### 2.1 业务目标

- 降低无效重试导致的时延与 token 浪费。
- 遇到非关键路径/非可恢复错误时快速失败，避免放大。
- 强化失败可解释性，支持后续阈值调优与运营复盘。

### 2.2 工程目标

- 将重试决策由“关键词判断”升级为“错误分类 + 上下文 + 退避策略”。
- 引入统一 `retry decision` 结构，支持日志与告警复用。
- 保持与现有 `feature_flags`、`review.retry_by_error_code` 兼容。

## 3. 对标点与映射

## 3.1 Open-ClaudeCode 可迁移思想

- 按 query/source 区分重试价值，避免后台放大量重试。
- 基于状态码与头部信号（如 `Retry-After`）动态退避。
- 指数退避 + 抖动，减少并发重试风暴。
- 重试与不可重试路径均产出可观测事件。

## 3.2 Appmaker 映射模块

- `src/convergence/execution-policy-engine.js`
- `src/engine.js`（`_executeWithRetry`）
- `src/review/error-codes.js`

## 4. 分轮实施计划

## Round 1（本轮）: 重试策略升级

范围：

- [x] R1-1 扩展 `ExecutionPolicyEngine`：输出结构化重试决策（是否重试、原因、建议延时、分类）。
- [x] R1-2 `engine._executeWithRetry` 接入结构化决策，支持 `Retry-After` + 指数退避抖动。
- [x] R1-3 增加重试路径观测字段（decision/reason/delay/error_code/phase）。
- [x] R1-4 为核心决策逻辑补单测，确保回归可控。

验收：

- 非重试错误可快速失败。
- 429/529 路径可优先遵循服务端退避信号。
- 同类瞬时错误的重试间隔具备抖动，避免齐步重试。
- 测试通过且既有行为不发生不可解释倒退。

## Round 2（下一轮）: 收益递减判定强化

范围：

- [x] R2-1 `file_change_effective` 从“文件名集合差异”升级为“内容哈希差异”。
- [x] R2-2 `ReviewConvergenceController` 从“单步差值”升级为“连续低增益窗口”。
- [x] R2-3 补充误判保护与软停止配置。

## Round 3（下一轮）: 输出稳态与观测补强

范围：

- [x] R3-1 引入 stream-json stdout guard，隔离非结构化噪声。
- [x] R3-2 统一 parse/schema/tool error 的可读语义。
- [x] R3-3 补充告警与报告模板字段。

## 5. 风险与缓解

- 风险: 重试减少过度导致成功率下降。
  - 缓解: 通过 `max_retries` 与策略阈值可配置回调，先小流量验证。
- 风险: 退避策略变复杂后排障难度上升。
  - 缓解: 增加结构化决策日志，确保每次重试可解释。

## 6. 回滚策略

- 代码层: 保留旧有 `_isRetryableError` 作为兜底路径。
- 配置层: 可通过 `review.retry_by_error_code` 与全局重试配置快速降级。

## 7. 本次提交范围说明

本次仅实施 Round 1，目标是“先稳住重试控制面”，不在本轮引入文件哈希与收敛窗口算法变更。
