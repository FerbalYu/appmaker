# NexusCodeForge 全局代码 Review

## 视角

这份 review 按一种偏 Karpathy 的工程审美来写：少一点宏大叙事，多一点可运行、可验证、可收敛。代码应该像一个能被单步调试的系统，而不是一堆“Agent”“智能”“自动化”的概念互相堆叠。

我的判断标准：

1. 能不能用最短路径解释主流程。
2. 出错时能不能定位到一个明确边界。
3. 配置、文档、测试、代码是否说的是同一件事。
4. 模块是否有单一职责，还是把产品、编排、策略、IO、日志、UI 推送全塞在一起。
5. 新人能否在 30 分钟内找到该改哪里。

## 当前结论

项目不是死路一条。核心想法是成立的：自然语言需求进入 Planner，产生 plan，Engine 调度 Coder 和 Reviewer，失败后修正，Daemon/Monitor 做状态与可观测性。

但当前实现确实“不伦不类”：它同时像 CLI、Agent runtime、workflow engine、tool runner、daemon、dashboard、评审系统、自动修复系统，并且很多边界没有真正收住。测试能跑过，说明底层若干块不是坏的；但系统的复杂度已经明显超过了当前抽象能力。

最核心的问题不是“功能不够”，而是“概念太多，主线太弱”。

## 已做的事实验证

### 测试

命令：

```bash
bun test
```

结果：

```text
94 pass
0 fail
243 expect() calls
```

说明：当前单测整体可运行，底层不少局部行为有覆盖。

### Lint

原状态下执行：

```bash
bun x eslint .
```

失败原因：项目声明了 lint 脚本，但没有 ESLint 配置文件。这个不是代码风格问题，而是工程入口坏了。

我已最小打通：新增 `.eslintrc.cjs`。现在 lint 能执行完成，结果为：

```text
0 errors, 37 warnings
```

这一步是“打通问题”，不是大重构。

## 最大文件与复杂度信号

当前最大文件：

| 文件 | 行数 | 判断 |
| --- | ---: | --- |
| `src/agents/universal-toolbox.js` | 2382 | 过大，工具注册、执行、安全、沙箱、状态混在一起 |
| `src/engine.js` | 1852 | 过大，编排、策略、恢复、评审循环、summary、prompt 构造混在一起 |
| `src/agents/native-coder.js` | 963 | 偏大，但主线相对清楚，是工具调用循环 |
| `src/planner.js` | 847 | 偏大，规划、AI 调用、fallback、Rainmaker 混合 |
| `cli.js` | 1066 | 过大，CLI 参数、daemon、monitor、asset scout、执行链路混合 |

这就是“不伦不类”的主要来源：不是某一段代码写得差，而是每个大模块都在吞职责。

## 架构主线

当前实际主线：

```text
cli.js
  -> Planner.plan / Planner.planByRainmaker
  -> ExecutionEngine.execute
  -> ExecutionEngine._executeMilestone
  -> ExecutionEngine._executeTask
  -> AgentDispatcher.dispatch
  -> NativeCoderAdapter.execute
  -> NativeReviewerAdapter.execute
  -> Engine 修正循环 / 收敛控制 / handoff
```

这个主线本身可以保留。

应该砍掉的是主线周围的概念噪音：CLI 里做太多运行期决策，Engine 里做太多策略判断，Toolbox 里做太多工具世界的事情。

## 关键问题清单

### P0：工程入口不自洽

#### 现象

`package.json` 里有：

```json
"lint": "bun x eslint ."
```

但仓库没有 ESLint 配置，导致 lint 直接失败。

#### 判断

这是非常典型的“看起来像工程化，实际上没打通”。

#### 已处理

新增 `.eslintrc.cjs`，使 lint 命令可运行。当前剩余是 warnings，不阻断。

---

### P0：配置系统存在“看起来有配置，实际没接上”的问题

#### 现象

`config/defaults.json` 有：

```json
{
  "engine": {
    "max_review_cycles": 0,
    "convergence": {},
    "feature_flags": {},
    "observability": {}
  },
  "review": {}
}
```

但是 `createEngine` 只是：

```js
export const createEngine = (cfg) => new ExecutionEngine(cfg);
```

CLI 执行时：

```js
const engine = createEngine({ project_root: executeDir });
```

这意味着 `config.engine` 并没有自然进入 `ExecutionEngine`。`ExecutionEngine` 自己内部又有一份默认配置。

#### 风险

用户以为改 `config/defaults.json` 会影响 engine，但实际上很多配置不会生效。文档、配置、运行时不一致，是自动化系统的大忌。

#### 建议

短期：修 `createEngine`，合并 `config.engine` 和 `config.review`。

目标：

```js
createEngine({ project_root })
```

应等价于：

```js
new ExecutionEngine({
  ...config.engine,
  review: config.review,
  project_root,
})
```

---

### P0：文档与代码默认值冲突

#### 现象

`skills/execution.skill.md` 写：

```text
max_review_cycles 默认值 3
```

但 `ExecutionEngine` 和 `config/defaults.json` 里是：

```js
max_review_cycles: 0
```

而代码语义是：

```js
while (needsFix && (this.maxReviewCycles <= 0 || cycle < this.maxReviewCycles))
```

也就是 `0` 代表无限循环，靠收敛控制器接管。

#### 风险

这是非常危险的不一致。一个自动修复系统，如果“最大循环次数”的文档与代码语义相反，用户会误判成本和风险。

#### 建议

要么改默认值为 `3`，要么明确 `0 = unlimited_with_convergence_controller`。我倾向改成显式语义：

```js
max_review_cycles: 3
unlimited_review_cycles: false
```

如果必须保留兼容，则文档和 config schema 必须说明 `0` 的含义。

---

### P1：`engine.js` 已经不是 Engine，而是半个系统

#### 现象

`engine.js` 负责：

- 任务依赖图
- 并发调度
- 单任务执行
- 编码调用
- 评审调用
- 修复 prompt 构造
- rollback/refix
- goal drift replan
- convergence controller 接入
- recovery coordinator 接入
- state probe
- feature flag audit
- release observer
- summary 聚合
- checkpoint restore
- alert emit

这不是一个 Engine，这是一个 God Object。

#### 判断

测试还能过，说明它不是坏死；但继续在这个文件上叠功能会让改动成本越来越高。

#### 建议拆块

保留 `ExecutionEngine` 作为编排门面，拆出：

1. `MilestoneScheduler`：依赖图、并发、blocked/deadlock。
2. `TaskRunner`：单任务 code -> review -> fix loop。
3. `ReviewLoopController`：review threshold、cycle、handoff、rollback/refix。
4. `ExecutionSummaryBuilder`：summary 计算。
5. `ExecutionContextBuilder`：rules、goal invariant、checkpoint 上下文。

先拆纯函数和低风险模块，不要一口吃掉整个 engine。

---

### P1：`universal-toolbox.js` 是另一个 God Object

#### 现象

一个文件里有 70+ 工具，包含：

- 文件系统
- bash
- git
- npm/yarn/pnpm
- 网络
- LSP
- task 管理
- workflow
- MCP
- agent/team
- interactive
- sandbox

还有内部状态：

```js
this.lspClients
this.subagents
this.bashProcesses
this.tasks
this.teams
this.cronJobs
this.planMode
this.worktrees
```

#### 判断

这类文件的典型问题是：任何工具的小改动都可能影响整个工具箱，测试和审查粒度都太粗。

#### 建议拆块

拆成：

```text
src/agents/tools/
  toolbox.js
  registry.js
  path-safety.js
  sandbox-toolbox.js
  file-tools.js
  bash-tools.js
  git-tools.js
  package-tools.js
  task-tools.js
  network-tools.js
  lsp-tools.js
```

第一步不要改行为，只把注册函数移动出去，测试保持原样。

---

### P1：CLI 里混入太多运行期业务逻辑

#### 现象

`cli.js` 做了：

- 参数解析
- 主目录安全检查
- daemon 生命周期
- monitor 生命周期
- plan/run/execute/status/logs/config 命令
- Rainmaker 模式
- reusable plan 查找
- checkpoint 状态读取
- AssetScout 游戏素材判断
- engine event forward
- 结果打印

尤其是 `executePlan` 中的 AssetScout 判断非常突兀：CLI 执行计划时突然用 Architect 决策是否下载素材。

#### 判断

CLI 应该薄，最多负责输入输出和命令路由。现在 CLI 像一个业务 orchestrator。

#### 建议拆块

拆成：

```text
src/cli/
  args.js
  commands/
    run.js
    plan.js
    execute.js
    status.js
    logs.js
    config.js
  runtime/
    daemon-lifecycle.js
    monitor-lifecycle.js
    execute-plan.js
    reusable-plan.js
```

AssetScout 决策应移动到 Planner 或专门的 `PreExecutionHooks`，不要放 CLI。

---

### P1：Agent 返回结构没有强 schema

#### 现象

Engine 依赖这些字段：

```js
codeResult.output.files_created
codeResult.output.files_modified
reviewResult.output.score
reviewResult.output.issues
```

但项目没有一个统一的 result schema 模块。各测试里也手写大量 mock result。

#### 风险

任何 Agent 改返回结构，Engine 可能静默走错分支。

#### 建议

新增：

```text
src/contracts/
  agent-result.js
  plan.js
  review.js
```

提供：

```js
normalizeCoderResult(result)
normalizeReviewerResult(result)
assertPlanShape(plan)
```

先做 runtime normalize，不急着引入 TypeScript。

---

### P1：测试能跑，但更像“局部行为测试”，缺少端到端契约测试

#### 现象

测试覆盖不少局部：engine、planner、permission、toolbox、convergence。

缺少几个非常关键的 e2e-lite 测试：

1. `createEngine()` 是否真正吃到 `config.engine`。
2. CLI `run --mock --dir temp` 是否能不触网地走完一个最小计划。
3. `max_review_cycles: 0` 的实际语义是否被明确测试。
4. Agent result shape 缺字段时 engine 是否报清楚错误。

#### 建议

新增 `tests/contracts.test.js` 和 `tests/cli-config.test.js`。

---

### P2：命名和概念过度营销化

#### 现象

项目里有：

- Rainmaker
- AssetScout
- MultiAgentThinker
- NativeCoder
- NativeReviewer
- Corrector
- Supervisor
- Daemon
- Engine
- Dispatcher
- ConvergenceController
- RecoveryCoordinator
- ReleaseObserver

单独看都能解释，但组合起来像一套产品叙事，而不是工程边界。

#### 判断

这不是审美问题，是维护问题。概念太多会导致每个新功能都不知道应该落在哪。

#### 建议

保留对外名字，内部按普通工程名组织：

```text
planner
executor
reviewer
toolbox
runtime
monitor
```

让“花名”成为 adapter，而不是系统骨架。

---

### P2：日志与 stdout 有冲突风险

已有 `stream-json-stdout-guard`，说明项目意识到了 stdout 污染问题。但大量 `console.log` 分散在 Planner、CLI、Engine、Toolbox、Sandbox 中。长期看需要统一 logger/channel。

建议：

- CLI 人类输出走 `console`。
- 机器输出走 `events` 或 structured logger。
- Agent thought/tool trace 不直接写 stdout。

---

## 当前不是死路的证据

1. 测试 94 个全过。
2. Dispatcher、Toolbox、Reviewer parser、Convergence 等局部模块已有可测边界。
3. Engine 虽大，但主流程清楚。
4. 已经有 `src/convergence`、`src/review` 这种拆分趋势，说明项目方向不是完全失控。

## 当前危险的地方

1. 如果继续加 Agent，会越来越乱。
2. 如果继续在 `engine.js` 加策略，会不可维护。
3. 如果继续在 `universal-toolbox.js` 加工具，会测试和安全审查失控。
4. 如果配置系统不打通，用户会不信任 CLI。
5. 如果文档继续和代码不一致，自动化越强，风险越大。

## 推荐策略

不要推倒重写。

正确做法是：

1. 先打通工程入口和配置入口。
2. 再把 contracts 固化。
3. 然后按块从大文件里抽模块。
4. 每抽一块跑测试。
5. 每次只动一个边界。

这项目的核心问题是“抽象债”，不是“代码全烂”。推倒重写会丢掉已有测试和已调通的复杂边界，不划算。
