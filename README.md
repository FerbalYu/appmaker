# appMaker

> AI 驱动的 APP 全自动开发系统。  
> **claude-code 编程 · opencode 毒舌点评 · minimax-mcp 智能规划 · 全自动修正闭环**

[![Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh)
[![ESM](https://img.shields.io/badge/Module-ESM-blue)](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Modules)
[![License](https://img.shields.io/badge/License-ISC-green)](./LICENSE)

---

## 核心理念

让 AI 自主完成从「一句话需求」到「可交付代码」的全流程，无需人类干预：

```
"做一个博客系统"
        ↓
  minimax-mcp 深度分析 → 生成执行计划
        ↓
  claude-code 编程实现
        ↓
  opencode 毒舌点评（PASS / FAIL）
        ↓                ↓
  继续下一任务      corrector 自动修正 → 重新评审
        ↓
  supervisor 全程监控 + 风险评估
```

---

## 角色分工

| Agent | 职责 | 类比 |
|---|---|---|
| **minimax-mcp** | 智能规划：深度分析需求 + 任务分解 + 依赖管理 | 架构师 |
| **claude-code** | 编程：写代码、修 bug、重构 | 资深程序员 |
| **opencode** | 毒舌点评：Code Review，必须找到 3+ 问题 | 严苛评审官 |
| **dispatcher** | 智能调度：任务路由 + 并行执行 + 并发控制 | 项目协调人 |
| **supervisor** | 进度监控：风险评估 + Token 告警 | 项目经理 |
| **corrector** | 自动修正：根因分析 + 策略选择 + 自我修复 | 质控专员 |

---

## 环境要求

- **[Bun](https://bun.sh) ≥ 1.0.0**（运行时，替代 Node.js）
- **claude-code CLI**（执行编程任务）
- **opencode CLI**（执行代码评审）
- **MiniMax API Key**（智能规划，可选）

### 安装 Bun

```bash
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# macOS / Linux
curl -fsSL https://bun.sh/install | bash
```

---

## 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 配置环境变量

复制 `.env.example` 并填写你的配置：

```bash
cp .env.example .env
```

```ini
# MiniMax API（智能规划，可选但推荐）
MINIMAX_API_KEY=your_api_key_here
MINIMAX_API_MODEL=MiniMax-M2.7
MINIMAX_API_HOST=https://api.minimaxi.com
MINIMAX_MCP_COMMAND=uvx
MINIMAX_MCP_ARGS=minimax-coding-plan-mcp,-y
```

> Bun 自动加载 `.env`，无需额外配置。

### 3. 检查 Agent 状态

```bash
bun cli.js health
```

### 4. 开始使用

```bash
# 一条命令全自动：需求 → 计划 → 执行 → 进度面板
bun cli.js run "做一个博客系统，支持文章发布和评论"

# 加 --yes 跳过确认，直接执行
bun cli.js run "做一个 TODO 应用" --yes

# 也可以分步操作
bun cli.js plan "做一个博客系统"        # 生成计划
bun cli.js execute plans/plan_xxx.json  # 执行计划
```

---

## CLI 命令参考

| 命令 | 说明 |
|---|---|
| `bun cli.js health` | 检查所有 Agent 可用性 |
| `bun cli.js plan "需求"` | 生成执行计划并保存到 `plans/` |
| `bun cli.js execute <plan.json>` | 执行指定计划文件 |
| `bun cli.js run "需求" [--yes]` | 自动生成计划并执行（推荐） |
| `bun cli.js run "需求" --dir ./target` | 指定项目工作目录 |

### 全局选项

| 选项 | 说明 |
|---|---|
| `--dir <path>` | 指定 Agent 的工作目录（默认 `cwd`） |
| `--yes` / `-y` | 跳过执行确认，适合 CI/CD |
| `DEBUG=1` | 输出详细错误堆栈 |

---

## 项目结构

```
appMaker/
├── cli.js                      # CLI 入口（#!/usr/bin/env bun）
├── bunfig.toml                 # Bun 配置
├── package.json                # "type": "module"（全量 ESM）
│
├── src/
│   ├── engine.js               # 执行引擎（编程→评审→修正循环）
│   ├── planner.js              # 规划器（自然语言→执行计划）
│   ├── supervisor.js           # 监督者（进度监控+风险评估）
│   ├── corrector.js            # 修正器（根因分析+自我修复）
│   ├── logger.js               # 日志系统
│   │
│   ├── agents/                 # Agent 适配器层
│   │   ├── index.js            # 统一导出 + 工厂函数
│   │   ├── base.js             # AgentAdapter 基类
│   │   ├── dispatcher.js       # 任务调度器
│   │   ├── acp-client.js       # JSON-RPC 2.0 ACP 客户端（Bun.spawn）
│   │   ├── claude-code.js      # Claude Code 适配器
│   │   ├── opencode.js         # OpenCode 适配器
│   │   ├── minimax-mcp.js      # MiniMax MCP 规划适配器
│   │   └── acp-bridges/        # ACP 桥接脚本
│   │
│   └── monitor/                # 进度监控服务（Bun.serve + SSE）
│       ├── index.js
│       └── public/
│           └── index.html      # Web 进度仪表盘
│
├── config/
│   ├── index.js                # 配置加载器（ESM）
│   ├── schema.js               # 配置 Schema 验证
│   ├── defaults.json           # 默认配置
│   └── agents.json             # Agent 配置（可覆盖）
│
├── rules/                      # AI 行为约束规则
│   ├── architecture.rules.md   # 架构分层约束
│   ├── quality.rules.md        # 代码质量规范
│   └── self-correction.rules.md # 自我修正流程
│
├── skills/                     # Agent 技能定义
│   ├── planning.skill.md
│   ├── execution.skill.md
│   ├── supervision.skill.md
│   └── agent-call.skill.md
│
├── plans/                      # 生成的计划文件（自动创建）
└── .appmaker/                  # 运行时数据（自动创建）
    ├── logs/                   # 执行日志
    └── checkpoints/            # 检查点（支持断点续跑）
```

---

## 配置说明

### `config/agents.json`

```json
{
  "agents": {
    "claude-code": {
      "enabled": true,
      "use_cli": true,
      "cli_path": "claude",
      "timeout_ms": 300000
    },
    "opencode": {
      "enabled": true,
      "use_cli": true,
      "cli_path": "opencode",
      "timeout_ms": 60000
    },
    "minimax-mcp": {
      "enabled": true
    }
  },
  "dispatcher": {
    "max_concurrent": 3
  },
  "engine": {
    "max_review_cycles": 3
  },
  "supervisor": {
    "thresholds": {
      "max_tokens": 100000,
      "max_errors": 5
    }
  }
}
```

---

## API 使用（ESM）

```javascript
import {
  createEngine,
  createPlanner,
  createDispatcher,
  healthCheck,
  dispatch,
  dispatchParallel
} from './src/agents/index.js';

// 健康检查
const status = await healthCheck();

// 生成执行计划
const planner = createPlanner({ project_root: './' });
const plan = await planner.plan('做一个博客系统');

// 执行计划
const engine = createEngine({ project_root: './', max_review_cycles: 3 });
const result = await engine.execute(plan);

// 单任务调度
const r = await dispatch({ type: 'architect', description: '设计系统架构' });

// 并行任务调度
const results = await dispatchParallel([
  { type: 'create', description: '创建用户模块' },
  { type: 'create', description: '创建文章模块' }
]);
```

---

## 进度监控面板

执行 `bun cli.js run` 时，系统自动启动实时 Web 仪表盘：

- **地址**：`http://localhost:8088`（端口冲突自动递增）
- **协议**：Server-Sent Events (SSE)，实时推送任务状态
- **展示**：里程碑进度 · 任务状态 · Token 消耗 · 错误告警

底层由 **`Bun.serve`** 驱动，零依赖、高性能。

---

## 自动修正机制

| 错误类型 | 严重度 | 处理策略 |
|---|---|---|
| 安全漏洞 / 架构违规 | 🔴 严重 | 立即停止，标记人工介入 |
| Token 超限 / 资源耗尽 | 🔴 严重 | 停止接受新任务 |
| 网络超时 / 临时故障 | 🟡 一般 | 自动重试 |
| 代码质量 / 逻辑 Bug | ⚪ 普通 | Agent 自我修正（最多 3 轮） |

评审 FAIL 时，系统最多进行 `max_review_cycles`（默认 3）次修正循环，超限则转人工。

---

## 技术栈

| 层 | 技术 |
|---|---|
| **运行时** | [Bun](https://bun.sh) 1.x |
| **模块系统** | 全量 ES Modules (`import/export`) |
| **Agent 通信** | JSON-RPC 2.0 over stdio (ACP 协议) |
| **Agent 调用** | `Bun.spawn`（跨平台，无 EINVAL） |
| **HTTP 服务** | `Bun.serve`（进度监控面板） |
| **HTTP 客户端** | 原生 `fetch` + `AbortSignal.timeout` |
| **进度推送** | Server-Sent Events (SSE) |
| **MCP 协议** | `@modelcontextprotocol/sdk` |
| **环境变量** | Bun 内置（无需 dotenv） |
| **测试** | `bun test`（内置，无需 Jest） |

---

## 更新日志

### v2.0.0 — 2026-03-31（当前版本）

- ⚡ **迁移至 Bun**：冷启动速度提升 ~10x，内存占用更低
- 📦 **全量 ESM**：所有模块改为 `import/export`，彻底现代化
- 🔧 **`Bun.spawn` 替代 `cross-spawn`**：根除 Windows `EINVAL` 错误
- 🌐 **`fetch` 替代 `axios`**：零依赖 HTTP 客户端
- 🖥️ **`Bun.serve` 替代 `http` 模块**：进度面板更轻量
- 🗑️ **移除冗余依赖**：移除 `dotenv`、`cross-spawn`、`jest`、`axios`（共 4 个）
- ✅ **`bun test` 替代 Jest**：零配置内置测试框架

### v1.0.0 — 2026-03-31

- ✨ 新增 MiniMax MCP 适配器：集成 MiniMax-M2.7 智能规划
- ⚡ 新增 Agent Dispatcher：并行执行 + 智能路由
- 📊 新增进度监控看板：Web UI 实时展示
- 🔧 新增自动修正系统：根因分析 + 自我修复
- 🛡️ 新增 Supervisor：风险评估 + Token 告警
- 🔗 新增 ACP 协议层：JSON-RPC 2.0 稳定通信

---

## 许可证

ISC © appMaker Contributors
