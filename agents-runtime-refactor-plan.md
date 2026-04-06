# Appmaker Agents Runtime 重构落地计划

## 1. 背景与目标

当前 `appmaker` 的 Agent 能跑，但执行控制、工具循环、上下文治理分散在各 Adapter 内，容易出现：

- 重入/旧异步状态覆盖新状态
- 工具循环空转或失败收敛不一致
- 上下文预算规则不统一
- trace 可观测性不足，问题难复盘

本计划目标：

1. 把“执行控制”从单 Agent 逻辑抽到通用 runtime 层。  
2. 让 `native-coder` 从“大函数”演进为“编排器 + 组件化能力”。  
3. 先保证“稳定不犯傻”，再逐步扩展到所有 Agent。

非目标（本阶段不做）：

- 不迁移重型安全策略引擎。
- 不做过度抽象的插件系统。

---

## 2. 总体架构（目标态）

新增目录：`src/agents/runtime/`

- `guard.js`：执行状态机（`idle/dispatching/running/stopping/finished` + generation）
- `trace.js`：统一 trace 工具（标准字段、exit trace、transition reason）
- `context-builder.js`：统一上下文预算与 prompt section 构建
- `tool-orchestrator.js`：统一工具调用编排（并发安全分区、失败预算、降级策略）

接入策略：

- `native-coder.js` 先接入上述 runtime 模块（第一优先）。
- 通过稳定后，再向 `native-reviewer.js` 扩展。

---

## 3. 分阶段实施

### Phase A：Runtime 底座

目标：先把通用能力模块化，减少 Adapter 内联复杂度。

任务：

1. 新建 `runtime/guard.js`  
   - 导出 `createExecutionGuard()`、`requestStop()`、`isTerminalStopReason()`
2. 新建 `runtime/trace.js`  
   - 导出 `createTraceRecorder()`，统一 `exit_stage/exit_note/guard_generation`
3. 新建 `runtime/context-builder.js`  
   - 导出 `buildBudgetedContextSections()`
4. 新建 `runtime/tool-orchestrator.js`  
   - 导出 `partitionToolCallsForExecution()` 与 `isConcurrencySafeTool()`

验收：

- `native-coder.js` 功能不变，行为不回归。
- 所有新增模块可单测覆盖。

### Phase B：NativeCoder 接入

目标：让 `native-coder.js` 只做编排，复杂逻辑下沉 runtime。

任务：

1. 替换本地 guard/trace/context/并发分区逻辑为 runtime 调用。
2. 保持既有 `stop_reason` 语义不变。
3. 保持 `execution_trace` 向后兼容。

验收：

- 现有 `tests/agents.test.js` 全绿。
- 新增 2~4 条“runtime 接入行为测试”。

### Phase C：扩展与推广

目标：把 runtime 能力推广到其他 agents。

任务：

1. `native-reviewer.js` 接入同一 guard + trace。
2. 逐步把共享上下文预算能力推广。

验收：

- reviewer 行为稳定，无 query 级回归。

---

## 4. 测试策略

优先测试：

1. `stop_reason` 一致性（重复调用/失败预算/无 tool_calls）。
2. 并发安全分区（只读并发、写操作串行）。
3. generation 防旧写回（过期 stop 请求不生效）。
4. budget 截断下 prompt 关键段落保留。

执行命令：

- `npm test -- tests/agents.test.js`

---

## 5. 风险与回滚

风险：

1. 抽模块后行为偏差。  
2. trace 字段变化影响上层消费。  
3. 并发批次执行顺序差异造成边界问题。

回滚策略：

1. 保持接口兼容，先“内部替换”再“外部推广”。  
2. 若出现问题，优先回退到 Adapter 内联实现（保留旧方法）。  
3. 分批提交，每批可独立回滚。

---

## 6. 本次执行清单（立即开始）

1. 新建 `src/agents/runtime/*.js` 初版。  
2. `native-coder.js` 接入 runtime 模块（guard/trace/context/orchestrator）。  
3. 调整测试并验证通过。  

