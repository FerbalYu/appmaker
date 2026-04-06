# native-coder 改造研究（拿来主义版，二次评估）

聚焦文件：`d:\workflow\appmaker\src\agents\native-coder.js`  
对照仓库：`d:\workflow\Open-ClaudeCode`

---

## 1. 当前结论（重新评估）

`native-coder` 已从“可跑”进展到“具备基础稳定性”，以下核心项已落地：

- 显式工具白名单（`TOOL_ALLOWLIST`）已启用，不再依赖顺序裁剪。
- `projectRoot` 路径拼接与 `git_status cwd` 已修复，目录错位风险显著下降。
- 重复工具调用检测（`MAX_SAME_TOOL_CALL`）已接入，具备基础防打转能力。
- `execution_trace` 已写入结果结构，可回放轮次、参数摘要、耗时与失败原因。
- 请求超时/外部取消已通过基类 `_requestCompletion()` 做 `try/finally cleanup`。

仍未完成的关键点是：循环治理的“状态机化”、上下文预算化、安全策略专门化。

---

## 2. 已完成计划（已落地）

### 2.1 已完成项清单

1. 工具筛选改造为 allowlist
   - 状态：完成
   - 价值：工具面稳定、可审计、可扩展。

2. 上下文路径修正（`projectRoot`）
   - 状态：完成
   - 价值：跨目录任务时不再误读 `package.json/README`，`git_status` 定位正确。

3. 重复 tool call 防打转
   - 状态：完成（基础版）
   - 价值：避免模型在同参数同工具上无限空转。

4. 请求层 timeout/abort 清理
   - 状态：完成（在 `AgentAdapter`）
   - 价值：减少定时器泄漏与中断后残留风险。

5. 执行轨迹输出（`execution_trace`）
   - 状态：完成
   - 价值：便于复盘“哪一轮做了什么、为什么失败”。

### 2.2 与 Open-ClaudeCode 的对应关系

- 对应 `createCombinedAbortSignal` 的思想：本项目已具备“组合信号 + cleanup”雏形。
- 对应 Query 循环安全思想：已实现“重复调用拦截”，但仍是轻量版。
- 对应权限分流思想：本项目已通过 `PermissionClassifier + executeTool` 具备底座。

---

## 3. 未来计划（下一阶段）

### P0（优先立即做）

1. 循环治理升级为“可终止状态机”
   - 拿来点：`Open-ClaudeCode/src/utils/QueryGuard.ts` 的状态流转思路。
   - 落地建议：引入 `running / stopping / finished`（或等价）状态，统一退出原因（无 tool_calls、重复调用、超上限、外部 abort、API 异常）。

2. 每轮工具调用上限 + 总失败预算
   - 拿来点：Open-ClaudeCode 在多处采用“兜底退出 + fail-safe”。
   - 落地建议：增加 `MAX_TOOL_CALLS_PER_STEP`、`MAX_TOOL_ERRORS_TOTAL`，超限后返回结构化 stop reason，而非仅 `break`。

3. needs_confirmation 的降级执行策略
   - 拿来点：权限结果可解释且可回退。
   - 落地建议：在 system prompt 明确：若工具返回 `needs_confirmation`，优先转只读分析、生成 patch 建议、列出人工确认点。

### P1（随后做）

4. 上下文预算模型（Context Budget）
   - 拿来点：Open-ClaudeCode 的上下文治理与 token 控制意识。
   - 落地建议：总预算（如 8k chars）按优先级分配：任务相关文件 > package.json > git status/diff > README。

5. `execution_trace` 标准化
   - 拿来点：可追踪、可观测、可归因。
   - 落地建议：补充 `stop_reason`、`api_round_trip_ms`、`tool_error_code` 字段，便于后续自动评估。

6. 命令安全策略专门化（PowerShell/Bash）
   - 拿来点：`Open-ClaudeCode/src/tools/PowerShellTool/powershellPermissions.ts` 的结构化判定。
   - 落地建议：在执行前做命令结构检查（下载执行、提权、持久化、危险路径写入），并与权限分类器结果合并决策。

### P2（增强项）

7. 请求信号能力对齐 `signalB` 模式
   - 拿来点：`createCombinedAbortSignal(signal, { signalB, timeoutMs })`。
   - 落地建议：在基类支持第二路取消信号（如会话级 stop），并保持清理逻辑集中。

8. 将主循环拆成小函数
   - 目标：降低 `execute()` 复杂度，提升可测性。
   - 建议拆分：`buildPrompt` / `requestModel` / `handleModelMessage` / `executeToolCalls` / `buildResult`。

---

## 4. 建议执行顺序（新的最小批次）

1. 批次 A：循环状态机 + 上限/预算 + stop reason（P0）。
2. 批次 B：needs_confirmation 降级策略 + prompt 更新（P0）。
3. 批次 C：上下文 budget + trace 标准化（P1）。
4. 批次 D：命令安全专门化（P1）。
5. 批次 E：请求信号双路化 + `execute()` 拆分（P2）。

---

## 5. 验收与测试清单（建议）

优先补到 `tests/agents.test.js`：

1. 重复调用达到阈值后，返回明确 `stop_reason`。
2. 单轮 tool_calls 过多时会被限流并安全退出。
3. 工具多次失败触发总失败预算退出。
4. `needs_confirmation` 场景下，模型能进入降级路径而非僵停。
5. 外部 `abort` 后，请求与循环均快速收敛，且无定时器残留。
6. context budget 生效时，prompt 大小稳定且关键信息优先保留。

---

## 6. 一句话总结

当前版本已补齐第一阶段稳定性底座；下一阶段应把“循环控制、安全决策、上下文预算”三件事做成可测、可解释、可复用的机制层，继续沿 `Open-ClaudeCode` 的成熟模式拿来即用。

---

## 7. 直接开工清单（函数级拆解）

以下按“低风险、可回滚、可测试”原则拆解，建议逐批提交。

### 批次 A：循环状态机 + 限流 + stop reason（P0）

目标：把“for 循环 + break”升级为“有状态、可观测、可解释退出”。

1. 新增循环状态与退出原因枚举
   - 文件：`src/agents/native-coder.js`
   - 建议新增：`LOOP_STATE`、`STOP_REASON` 常量。
   - 至少覆盖：`no_tool_calls`、`repeated_tool_call`、`tool_calls_limit`、`tool_errors_limit`、`external_abort`、`api_error`、`max_steps_reached`。

2. 增加每轮工具调用上限与总失败预算
   - 文件：`src/agents/native-coder.js`
   - 建议新增：`MAX_TOOL_CALLS_PER_STEP`、`MAX_TOOL_ERRORS_TOTAL`。
   - 行为：触发后不直接静默 `break`，而是设置 `stop_reason` 并返回可读 summary。

3. 扩展 `execution_trace` 结构
   - 文件：`src/agents/native-coder.js`
   - 新字段建议：`stop_reason`（最终输出级别）、`api_round_trip_ms`（每轮）、`tool_error_code`（工具失败时）。
   - 原则：向后兼容，旧字段保留。

验收标准：同一输入可稳定复现实验性退出路径，且输出中能明确看到 stop reason。

### 批次 B：needs_confirmation 降级执行（P0）

目标：中风险工具被拦截时，任务不“卡死”，而是自动降级继续产出。

1. system prompt 增加降级协议
   - 文件：`src/agents/native-coder.js`
   - 规则：遇到 `needs_confirmation` 时，优先执行只读分析、生成 patch 建议、列出人工确认项。

2. tool result 识别 `needs_confirmation`
   - 文件：`src/agents/native-coder.js`
   - 行为：将此类结果写入 trace，并给模型结构化反馈（包含建议替代动作）。

验收标准：模拟 `need_confirm` 场景时，仍输出可执行的替代方案，不会反复请求同一高风险工具。

### 批次 C：上下文预算 + trace 标准化（P1）

目标：控制 prompt 膨胀，优先保留高价值上下文。

1. 引入 `contextBudget` 配置
   - 文件：`src/agents/native-coder.js`
   - 建议：默认 8k chars，总量硬上限。
   - 分配建议：任务相关文件 > `package.json` > `git status/diff` > `README`。

2. 上下文构建改为预算感知
   - 文件：`src/agents/native-coder.js`
   - 行为：每段上下文写入前计算剩余预算，超预算时截断并记录 `truncated: true`。

验收标准：大仓库任务下 prompt 长度稳定，且核心上下文不被低优先级内容挤掉。

### 批次 D：命令安全专门化（P1）

目标：对 `bash_execute`/PowerShell 形成结构化安全护栏。

1. 新增命令策略检查层（preflight）
   - 文件：建议新增 `src/security/command-policy.js`（或等价路径）
   - 检查项：下载执行、提权、持久化、自修改启动项、危险路径写入。
   - 输出：`{ allowed, risk, reason, rule_id }`。

2. 与 `PermissionClassifier` 合并裁决
   - 文件：`src/agents/base.js` 与 `src/agents/native-coder.js`
   - 原则：高风险直接 deny，中风险走 confirm/降级，低风险放行。

验收标准：危险命令被稳定阻断，且模型可收到明确、可解释的拒绝原因。

### 批次 E：请求信号双路化 + 主循环拆分（P2）

目标：降低复杂度，增强可维护与可测性。

1. 信号增强到 `signal + signalB + timeoutMs`
   - 文件：`src/agents/base.js`
   - 行为：兼容现有接口，支持双路取消并统一 cleanup。

2. `execute()` 拆分
   - 文件：`src/agents/native-coder.js`
   - 建议拆分函数：`_buildPrompts`、`_runToolLoop`、`_handleToolCalls`、`_finalizeResult`。

验收标准：`execute()` 主流程可读性显著提升，新增逻辑可通过单元测试独立覆盖。

---

## 8. 风险与回滚策略（落地保障）

1. 风险：状态机改造引入行为偏差
   - 保障：通过 feature flag（如 `NATIVE_CODER_STATE_MACHINE=1`）灰度开启。
   - 回滚：关闭开关，退回旧循环逻辑。

2. 风险：上下文预算导致信息不全
   - 保障：trace 中记录被截断来源与长度。
   - 回滚：临时提升预算或禁用预算策略。

3. 风险：安全策略过严影响可用性
   - 保障：策略结果分级（deny/confirm/allow）并配可解释 reason。
   - 回滚：对误伤规则做白名单豁免，保留审计记录。

---

## 9. 下一步建议（本周执行）

建议本周只做“批次 A + 批次 B”，先完成可控退出与降级执行，再进入预算与安全专门化。  
这样可以先把“跑飞”和“卡死”两类高频故障压住，后续改造成本更低。

---

## 10. 纠偏结论（重要）

这里明确纠偏：`appmaker` 当前目标不是照搬 `Open-ClaudeCode` 的完整安全体系。  
当前最优先是让 `native-coder.js` “不犯傻、可预测、可收敛”，而不是建设一套重安全平台。

换句话说：

- 要做：防空转、防重复、防超量、防卡死、防无产出。
- 暂不做：PowerShell AST 级权限引擎、复杂策略归约框架、完整 command policy 子系统。

---

## 11. 轻量防傻方案（只针对 `native-coder.js`）

### 11.1 必做能力（小而硬）

1. 终态统一（已做一半，继续收口）
   - 新增/固定：`_isTerminalStopReason(reason)`。
   - 作用：所有退出都走同一判定，避免“看似结束但状态不一致”。

2. 循环守卫最小状态机（轻量）
   - 只保留：`running -> stopping -> finished`。
   - 增加 `generation` 防旧异步写回（轻量实现即可，不引入复杂类）。

3. 工具调用硬约束（已做，继续强化）
   - 单轮上限、总失败预算、重复调用阈值。
   - 达阈值后必须输出明确 `stop_reason` 和人类可读 summary。

4. needs_confirmation 降级（已做，继续稳定）
   - 禁止模型反复撞同一高风险工具。
   - 必须回退为“只读分析 + patch 建议 + 人工确认清单”。

5. 上下文预算（已做，继续打磨）
   - 保证 prompt 收敛，不被低价值内容挤爆。
   - 保留 `budgetMeta` 便于问题复盘。

### 11.2 不做项（当前阶段明确排除）

1. 不引入 `src/security/command-policy.js` 独立框架。
2. 不迁移 `Open-ClaudeCode` 的 PowerShell 细粒度 AST 规则体系。
3. 不在本阶段扩展多层 permission reduce 引擎。

这些都属于“体系化安全建设”，当前不是主目标，避免过度设计。

---

## 12. 接下来只做这 3 件事

1. `native-coder.js` 增加 `_isTerminalStopReason()` + 轻量 `generation` 守卫。
2. `execution_trace` 增加两个最小字段：`exit_stage`、`exit_note`（只做可观察性，不搞大而全）。
3. `tests/agents.test.js` 补 3 条回归：
   - 重复调用/失败预算/无 tool_calls 的 stop_reason 一致性。
   - `needs_confirmation` 不会重复撞同一命令。
   - budget 截断下仍能保留“项目需求 + 核心上下文”。

验收标准（单句）：
同一类异常输入，`native-coder` 每次都以相同 stop_reason 收敛，并产出可读的下一步建议。
