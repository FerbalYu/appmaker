# NexusCodeForge 重构与打通计划

## 原则

这不是推倒重写计划，而是“压缩复杂度、固化契约、逐块拆分”的计划。

判断标准：

1. 每一步都能单独验证。
2. 每一步都减少一个真实风险。
3. 不引入新的宏大抽象。
4. 不做没有测试保护的大搬迁。
5. 优先打通入口，再拆大块。

## 成功标准

最终目标不是“文件变少”，而是：

```text
用户改配置 -> 运行时真的生效
Planner 输出 plan -> Engine 明确验证 shape
Coder/Reviewer 返回结果 -> Engine 通过 contract normalize 后使用
CLI 只负责命令路由 -> 执行逻辑在 runtime 层
Engine 只负责编排 -> review loop / summary / context / scheduler 各自可测
Toolbox 只负责注册和执行 -> 工具按类别分文件
```

## Phase 0：立即打通工程入口

### 0.1 打通 lint

状态：✅ 已完成（2026-05-07）

问题：`package.json` 声明 `bun x eslint .`，但仓库没有 ESLint 配置。

动作：新增 `.eslintrc.cjs`。

验证：

```bash
bun x eslint .
```

期望：退出码 0，允许 warnings。

### 0.2 打通 Engine 配置入口

状态：✅ 已完成（2026-05-07）

问题：`config/defaults.json` 里的 `engine` 和 `review` 没有通过 `createEngine()` 自动注入 `ExecutionEngine`。

动作：修改 `src/agents/index.js`：

```js
createEngine(cfg)
```

应合并：

```js
config.engine
config.review
cfg
```

验证：新增或修改测试，确认：

```js
createEngine({ project_root }).config.convergence.window_size
```

来自配置默认值，并且调用参数可以覆盖默认值。

### 0.3 明确 `max_review_cycles: 0` 的语义

状态：✅ 已完成（2026-05-07）

问题：文档说默认 3，代码默认 0，且 0 表示不限轮次。

短期动作：更新文档/计划说明，明确 `0 = unlimited, guarded by convergence controller`。

已完成动作：
- `skills/execution.skill.md` 配置表已修正默认值为 0
- README 示例已更新
- 文档已统一为 `0 = 不限，由收敛控制器保护`

验证：测试覆盖 `0` 和正整数两种行为。

## Phase 1：固化 contracts

### 1.1 新增 Agent Result contract

状态：✅ 已完成（2026-05-07）

新增：

```text
src/contracts/agent-result.js
```

提供：

```js
normalizeCoderResult(result)
normalizeReviewerResult(result)
```

目标：Engine 不再直接相信任意 Agent 返回结构。

最小行为：

- 缺少 `output` 时补默认结构。
- `files_created/files_modified` 非数组时归一化为空数组。
- `score` 非 number 时返回结构化错误。
- `issues` 非数组时归一化为空数组或报 schema error。

验证：

```text
tests/contracts.test.js
```

覆盖：

- 正常 coder result。
- 缺字段 coder result。
- 正常 reviewer result。
- reviewer score 缺失。

### 1.2 新增 Plan contract

状态：✅ 已完成（2026-05-07）

新增：

```text
src/contracts/plan.js
```

提供：

```js
normalizePlan(plan)
assertPlanShape(plan)
```

目标：Planner 输出、execute 读取 plan、Rainmaker 输出都经过同一个入口。

验证：

- tasks 缺失时报清晰错误。
- milestones 引用不存在 task 时给出结构化错误。
- dependencies 不是数组时归一化。

## Phase 2：收缩 CLI

### 2.1 抽参数解析

状态：✅ 已完成（2026-05-07）

新增：

```text
src/cli/args.js
```

从 `cli.js` 移出：

- `--dir`
- `--no-daemon`
- `--mock`
- `--dry-run`
- `--yes`
- `--output-format`

验证：新增 `tests/cli-args.test.js`。

### 2.2 抽 runtime lifecycle

状态：✅ 已完成（2026-05-07）

新增：

```text
src/cli/runtime/daemon-lifecycle.js
src/cli/runtime/monitor-lifecycle.js
```

目标：`cli.js` 不直接管理 daemon 和 monitor 细节。

验证：mock daemon/monitor，确认 start/stop 顺序。

### 2.3 抽 executePlan

状态：✅ 已完成（2026-05-07）

新增：

```text
src/cli/runtime/execute-plan.js
```

移动内容：

- writable 检查
- daemon session 记录
- engine 创建
- supervisor 创建
- event forward
- summary 打印

验证：用 mock engine 跑一次最小 plan。

### 2.4 移出 AssetScout 决策

当前位置：`cli.js executePlan`。

目标位置：

```text
src/hooks/pre-execution/asset-scout-hook.js
```

或直接并入 Planner/Rainmaker。

短期动作：抽成 hook，不改变行为。

长期动作：让 plan 显式声明是否需要 assets，而不是 CLI 猜。

## Phase 3：拆 Engine

### 3.1 抽 SummaryBuilder

状态：✅ 已完成（2026-05-07）

新增：

```text
src/engine/summary-builder.js
```

移动：`_generateSummary`。

验证：直接单测 summary 输入输出。

收益：低风险、高确定性。

### 3.2 抽 ExecutionContextBuilder

状态：✅ 已完成（2026-05-07）

新增：

```text
src/engine/context-builder.js
```

移动：

- `_buildContext`
- `_loadRule`
- `_buildGoalInvariant`

验证：mock filesystem，确认 rules 加载、goal invariant 构造。

### 3.3 抽 MilestoneScheduler

状态：✅ 已完成（2026-05-07）

新增：

```text
src/engine/milestone-scheduler.js
```

移动：

- `_buildTaskGraph`
- `_getAvailableTasks`
- blocked/deadlock 判断核心逻辑

Engine 保留事件和日志外壳。

验证：

- 无依赖并发。
- 依赖完成后调度。
- 上游失败导致 blocked。
- 环状依赖导致 deadlock。

### 3.4 抽 ReviewLoopRunner

状态：✅ 已完成（2026-05-07）

新增：

```text
src/engine/review-loop-runner.js
```

移动：

- code -> review -> fix -> re-review 主循环
- rollback/refix
- forced goal replan
- handoff 结果构造

这是最大风险步骤，必须在前面 contract 和 scheduler 拆完后再做。

验证：复用当前 `engine.test.js` 中 review cycle 相关测试。

## Phase 4：拆 Toolbox

### 4.1 抽 path safety

状态：✅ 已完成（2026-05-07）

新增：

```text
src/agents/tools/path-safety.js
```

移动：

- workspace root resolve
- path escape 判断
- cwd resolve

验证：复用已有 workspace escape 测试。

### 4.2 抽 registry

状态：❌ 跳过

说明：`_registerTool`、`getToolsMetadata`、`execute` 方法保留在 `UniversalToolbox` 类上，通过 delegate 模式调用各工具文件的 `register*Tools(this)`。抽取独立 registry 类会引入不必要的抽象层，且工具文件已通过 `TOOL_CATEGORIES` 常量共享分类信息。

新增：

```text
src/agents/tools/registry.js
```

提供：

```js
registerTool(name, category, description, inputSchema, handler)
getToolsMetadata()
execute(toolName, args)
```

UniversalToolbox 变成组合对象。

### 4.3 按类别搬工具

状态：✅ 已完成（2026-05-07）

已创建 14 个工具文件：

顺序：

1. file tools
2. bash tools
3. git tools
4. package tools
5. task tools
6. network tools
7. lsp tools
8. workflow/mcp/agent/interactive/utility

每搬一类跑：

```bash
bun test tests/permission-toolbox.test.js
bun test
```

已创建 14 个工具文件：

| 文件 | 工具数 | 说明 |
|------|--------|------|
| `src/agents/tools/file-tools.js` | 13 | 文件系统 |
| `src/agents/tools/bash-tools.js` | 10 | 命令执行 |
| `src/agents/tools/git-tools.js` | 6 | Git 操作 |
| `src/agents/tools/package-manager-tools.js` | 4 | 包管理器 |
| `src/agents/tools/network-tools.js` | 4 | 网络请求 |
| `src/agents/tools/code-edit-tools.js` | 4 | 代码编辑 |
| `src/agents/tools/lsp-tools.js` | 4 | LSP 集成 |
| `src/agents/tools/subagent-tools.js` | 4 | 子代理 |
| `src/agents/tools/task-tools.js` | 7 | 任务管理 |
| `src/agents/tools/workflow-tools.js` | 8 | 工作流 |
| `src/agents/tools/mcp-tools.js` | 4 | MCP 集成 |
| `src/agents/tools/agent-tools.js` | 5 | 代理编排 |
| `src/agents/tools/interactive-tools.js` | 6 | 交互 |
| `src/agents/tools/utility-tools.js` | 4 | 辅助 |

`universal-toolbox.js` 从 2382 行缩减至 307 行（−87%）。

验证：109 tests pass, 0 fail

### 4.4 抽 SandboxToolbox

状态：❌ 跳过（发现循环依赖）

说明：`SandboxToolbox extends UniversalToolbox` 而 `universal-toolbox.js` 也需导出 `SandboxToolbox`，独立文件会导致循环 import。保留内联（65 行）在 `universal-toolbox.js` 底部。

## Phase 5：统一日志与 stdout

### 5.1 定义输出通道

状态：✅ 已完成（2026-05-07）

规则：

```text
CLI 人类可读输出 -> stdout
机器 JSON 输出 -> stdout only JSON
日志/trace/thought -> stderr 或 event bus
```

新建：`src/ops/log-channel.js` — `LogChannel` 类，支持 stdout/stderr 分离、JSON 模式、prefix 继承。

### 5.2 移除核心模块散落 console.log

状态：🟡 部分完成（2026-05-07）

优先级：

1. ~~Planner spinner / AI 输出~~ → 保留（Planner 的 console.log 是用户可读的进度输出，符合 Phase 5.1 规则）
2. ~~NativeCoder tool trace~~ → 保留（Agent 内部调试输出）
3. ✅ SandboxToolbox log — 已有 `config.logger` 回退机制
4. ✅ Engine summary — `_log` 和 `_reportProgress` 已支持 `_logChannel` 注入

已注入：`engine._log` 和 `engine._reportProgress` 通过 `config._logChannel` 支持外部日志通道。

验证：

```bash
bun test tests/stream-json-stdout-guard.test.js
```

## Phase 6：文档收敛

### 6.1 更新 README

状态：✅ 已完成（2026-05-07）

已修正 README 中的 `max_review_cycles: 3` 与代码默认值不一致的问题。

### 6.2 更新 skills 文档

状态：✅ 已完成（2026-05-07）

已修正 `skills/execution.skill.md`：
- `max_review_cycles` 默认值 3 → 0
- `task_timeout` 默认值 300000 → 0
- 移除不存在的 `token_budget` 配置项
- 移除示例代码中不存在的 `token_budget` 参数

### 6.3 删除或归档过期规划文档

状态：⏸️ 保留观察

- `agents-overhaul-master-plan.md` — 保留，标记已有落地（A/B 已落地，C/D/E 部分落地）
- `open-claudecode-adaptation-plan.md` — 保留

## 推荐执行顺序

最小稳定路线：

```text
0.1 lint 打通
0.2 createEngine 配置打通
1.1 Agent result contracts
3.1 SummaryBuilder
3.2 ExecutionContextBuilder
2.1 CLI args
2.3 executePlan
4.1 path safety
4.2 toolbox registry
4.3 按类别拆 toolbox
3.3 scheduler
3.4 review loop
```

不要先拆最难的 `engine._executeTask`。那是诱人的，但风险最大。

## 每阶段验证命令

基础：

```bash
bun test
bun x eslint .
```

局部：

```bash
bun test tests/engine.test.js
bun test tests/agents.test.js
bun test tests/permission-toolbox.test.js
bun test tests/planner.test.js
```

CLI 冒烟：

```bash
bun cli.js health --dir <temp-project> --no-daemon
bun cli.js run "创建一个 hello 文件" --mock --yes --dir <temp-project>
```

## 不建议做的事

1. 不建议改成 TypeScript 作为第一步。当前最大问题是边界，不是类型系统。
2. 不建议换测试框架。
3. 不建议重写 Engine。
4. 不建议一次性拆 UniversalToolbox。
5. 不建议继续增加新 Agent 名词。
6. 不建议在 CLI 里继续加业务策略。

## 当前已完成动作

### Phase 0 — 工程入口 ✅
1. `0.1` lint 打通 — 新增 `.eslintrc.cjs`
2. `0.2` Engine 配置入口 — `createEngine()` 自动合并 `config.engine` + `config.review`
3. `0.3` `max_review_cycles: 0` 语义明确 — 文档统一为 `0 = 不限，由收敛控制器保护`

### Phase 1 — 契约固化 ✅
4. `1.1` Agent Result contract — `normalizeCoderResult` / `normalizeReviewerResult`
5. `1.2` Plan contract — `normalizePlan` / `assertPlanShape`

### Phase 2 — CLI 收缩 ✅
6. `2.1` 参数解析抽离 — `src/cli/parse-args.js`（cli.js −37%）
7. `2.2` Runtime lifecycle — `src/cli/runtime/daemon-lifecycle.js` / `monitor-lifecycle.js`
8. `2.3` executePlan — `src/cli/runtime/execute-plan.js`

### Phase 3 — Engine 拆分 ✅
9. `3.1` SummaryBuilder — `src/engine/summary-builder.js`
10. `3.2` ExecutionContextBuilder — `src/engine/context-builder.js`
11. `3.3` MilestoneScheduler — `src/engine/milestone-scheduler.js`
12. `3.4` ReviewLoopRunner — `src/engine/review-loop-runner.js`（engine.js −18%）

### Phase 4 — Toolbox 拆分 ✅
13. `4.1` path-safety — `src/agents/tools/path-safety.js`
14. `4.2` registry — 跳过（delegate 模式已足够）
15. `4.3` 14 个工具类别文件 — universal-toolbox.js −87%（2382 → 307 行）
16. `4.4` SandboxToolbox — 跳过（循环依赖，保留内联）

### Phase 5 — 日志统一 🟡
17. `5.1` LogChannel — `src/ops/log-channel.js`
18. `5.2` engine `_log` / `_reportProgress` 支持 `_logChannel` 注入

### Phase 6 — 文档收敛 ✅
19. `6.1` README 默认值修正
20. `6.2` skills/execution.skill.md 配置表修正

### 测试状态
```text
109 pass, 0 fail, 294 expect() calls
Ran 109 tests across 9 files.
```

### 效果汇总

| 指标 | 重构前 | 重构后 |
|------|--------|--------|
| `cli.js` | ~1030 行 | ~650 行 (−37%) |
| `engine.js` | 1869 行 | ~1530 行 (−18%) |
| `universal-toolbox.js` | 2382 行 | 307 行 (−87%) |
| 新建模块 | 0 | 24 个 |

## 后续建议

按风险从低到高：

1. **2.4 AssetScout 决策移出 CLI** — 抽成 pre-execution hook，不改变行为
2. **5.2 继续注入 log channel** — 给 Planner、Supervisor、Dispatcher 注入 LogChannel，消除 `console.log` 硬依赖
3. **拆 `engine._executeTask`** — 当前最大复杂度所在（约 400 行），应在 contract 和 scheduler 稳定后再拆
