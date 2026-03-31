# appMaker

AI 驱动的 APP 开发系统。核心理念：**claude-code 编程 + opencode 毒舌点评** + **智能调度 + 自动修正**。

## 角色分工

| Agent           | 职责                | 模式  |
| --------------- | ----------------- | --- |
| **claude-code** | 编程（写代码）           | 执行者 |
| **opencode**    | 毒舌点评（Code Review） | 评审者 |
| **minimax-mcp** | 智能规划（架构设计+任务分解） | 规划者 |
| **dispatcher**  | 任务调度（智能路由+并行执行） | 协调者 |
| **supervisor**  | 进度监控（风险评估+质量检查） | 监督者 |
| **corrector**   | 自动修正（问题分析+自我修复） | 修正者 |

## 核心协作流程

```
需求输入
   ↓
minimax-mcp 智能规划（架构设计+任务分解）
   ↓
dispatcher 智能调度（选择合适的 Agent）
   ↓
claude-code 写代码
   ↓
opencode 毒舌点评（必须找到 3+ 问题）
   ↓
  ├─ PASS → 继续下一个任务
  └─ FAIL → corrector 自动修正
                   ↓
            修正成功 → 继续执行
            修正失败 → supervisor 标记人工介入
                   ↓
supervisor 进度监控 + 风险评估
```

## 快速开始

```bash
# 1. 检查 Agent 是否可用
node cli.js health

# 2. 直接运行（自然语言 → 自动生成计划 → 执行）
node cli.js run "做一个博客系统，支持文章发布和评论"

# 或者分步操作：
# 3. 先生成计划
node cli.js plan "做一个博客系统"

# 4. 查看计划后执行
node cli.js execute plans/plan_xxx.json
```

## CLI 命令

| 命令                           | 说明                 |
| ---------------------------- | ------------------ |
| `node cli.js health`         | 检查 Agent 可用性       |
| `node cli.js plan "需求"`      | 生成执行计划（保存到 plans/） |
| `node cli.js execute <plan>` | 执行计划文件             |
| `node cli.js run "需求"`       | 自动生成计划并运行（附带进度面板UI） |

> **提示:** 使用 `node cli.js run` 时，系统将启动 `ProgressMonitor` Web 进图仪表盘服务并在浏览器中自动打开显示。

## 示例

```bash
# 博客系统
node cli.js run "做一个博客系统，支持文章发布和评论"

# 电商后台
node cli.js run "做一个电商后台管理系统，支持商品管理、订单处理"

# 系统升级
node cli.js run "升级用户认证模块，支持多因素认证"

# API 开发
node cli.js run "开发一个 RESTful API，提供用户管理功能"
```

## 项目结构

```
appMaker/
├── cli.js                 # 命令行入口
├── src/
│   ├── planner.js        # 需求 → 计划（集成 minimax-mcp）
│   ├── engine.js         # 执行引擎
│   ├── supervisor.js     # 监督者（进度监控+风险评估）
│   ├── corrector.js      # 自动修正器（问题分析+自我修复）
│   ├── logger.js         # 日志系统
│   ├── monitor/          # 进度监控服务
│   │   ├── index.js      # SSE 监控服务器
│   │   └── public/
│   │       └── index.html # Web 进度仪表盘
│   └── agents/           # Agent 适配器
│       ├── index.js      # Agent 系统主入口
│       ├── base.js       # 基础适配器
│       ├── dispatcher.js # 任务调度器（智能路由+并行）
│       ├── minimax-mcp.js # MiniMax MCP 规划器
│       ├── claude-code.js # Claude-Code 适配器
│       └── opencode.js   # OpenCode 适配器
├── rules/                # 约束规则
│   ├── architecture.rules.md   # 架构分层约束
│   ├── quality.rules.md        # 代码质量规范
│   └── self-correction.rules.md # 自我修正流程
├── skills/               # 技能定义
│   ├── planning.skill.md       # 需求拆解技能
│   ├── execution.skill.md      # 任务执行技能
│   ├── supervision.skill.md    # 进度监控技能
│   └── agent-call.skill.md     # Agent 调用技能
├── config/               # 配置文件
│   └── agents.json       # Agent 配置
├── logs/                 # 日志文件
└── plans/                # 生成的计划存放
```

## 配置

### 环境变量配置（推荐）

创建 `.env` 文件或设置环境变量：

```bash
# MiniMax API 配置（用于智能规划）
MINIMAX_API_KEY=your_api_key_here
MINIMAX_API_MODEL=MiniMax-M2.7
MINIMAX_API_HOST=https://api.minimaxi.com
MINIMAX_MCP_COMMAND=uvx
MINIMAX_MCP_ARGS=minimax-coding-plan-mcp,-y

# Agent 超时配置（毫秒）
CLAUDE_CODE_TIMEOUT=300000
OPENCODE_TIMEOUT=60000

# 调度器配置
MAX_CONCURRENT_TASKS=3
```

### Agent 配置文件

编辑 `config/agents.json`：

```json
{
  "agents": {
    "claude-code": {
      "enabled": true,
      "cli_path": "claude-code",
      "timeout_ms": 300000
    },
    "opencode": {
      "enabled": true,
      "cli_path": "opencode",
      "timeout_ms": 60000
    },
    "minimax-mcp": {
      "enabled": true,
      "capabilities": [
        "complex-reasoning",
        "web-search",
        "image-understanding",
        "architecture-design"
      ]
    }
  },
  "dispatcher": {
    "max_concurrent": 3
  },
  "supervisor": {
    "thresholds": {
      "max_tokens": 100000,
      "max_errors": 5
    }
  }
}
```

## 核心功能

### 🎯 智能规划（minimax-mcp）

基于 MiniMax-M2.7 模型 + MCP 协议，提供智能需求分析和任务分解：
- **架构设计**：深度推理，生成落地架构方案
- **任务分解**：自动拆解为可执行的任务列表
- **依赖管理**：智能识别任务间的依赖关系
- **资源估算**：预估 Token 消耗和执行时间

```javascript
const { Planner } = require('./src/agents');
const planner = new Planner({ project_root: './' });
const plan = await planner.plan('做一个博客系统，支持文章发布和评论');
```

### ⚡ 智能调度（Dispatcher）

任务智能路由到合适的 Agent：
- **类型映射**：根据任务类型自动选择 Agent（create→claude-code, review→opencode）
- **并行执行**：独立任务并行执行，提升效率
- **并发控制**：最大并发数可配置，避免资源耗尽

```javascript
const { AgentDispatcher } = require('./src/agents');
const dispatcher = createDispatcher();
const result = await dispatcher.dispatch({ type: 'architect', description: '设计系统架构' });
```

### 📊 进度监控（Progress Monitor）

实时 Web 进度仪表盘：
- **SSE 推送**：Server-Sent Events 实时更新
- **里程碑跟踪**：清晰展示当前阶段和完成进度
- **Token 统计**：实时监控 Token 消耗
- **风险预警**：自动评估执行风险

使用 `node cli.js run` 时自动启动，访问 `http://localhost:8088`

### 🔧 自动修正（Supervisor + Corrector）

智能问题分析和自我修复：
- **根因分析**：自动识别错误类型（网络、代码、安全等）
- **策略选择**：根据错误类型选择修正策略
- **自动修复**：可自我修正的问题自动触发 Agent 修复
- **人工介入**：无法自动修复时标记需要人工处理

修正规则：
- 🔴 严重问题（安全漏洞、架构违规、资源耗尽）→ 立即停止，等待人工介入
- 🟡 临时问题（网络超时、临时故障）→ 自动重试
- ⚪ 代码质量 → Agent 自我修正

## 计划格式

`plans/` 下的计划文件是 JSON 格式：

```json
{
  "plan_id": "plan_1234567890",
  "project": {
    "name": "博客系统",
    "description": "做一个博客系统，支持文章发布和评论"
  },
  "milestones": [
    { "id": "m1", "name": "基础框架", "tasks": ["t1", "t2"] },
    { "id": "m2", "name": "功能开发", "tasks": ["t3", "t4", "t5"] },
    { "id": "m3", "name": "集成测试", "tasks": ["t6"] },
    { "id": "m4", "name": "上线准备", "tasks": ["t7", "t8"] }
  ],
  "tasks": [
    { 
      "id": "t1", 
      "description": "初始化项目结构", 
      "type": "architect",
      "agent": "claude-code", 
      "estimated_tokens": 2000,
      "estimated_minutes": 15
    }
  ],
  "metadata": {
    "total_tasks": 8,
    "estimated_tokens": 15000,
    "total_minutes_estimate": 60
  }
}
```

## API 使用

### 基础使用

```javascript
const { createEngine, createPlanner, healthCheck, createDispatcher } = require('./src/agents');

// 健康检查
const status = await healthCheck();

// 生成计划（使用 MiniMax MCP）
const planner = createPlanner({ project_root: './' });
const plan = await planner.plan('做一个博客系统');

// 创建调度器
const dispatcher = createDispatcher();

// 执行计划（带进度监控）
const engine = createEngine({ 
  project_root: './',
  dispatcher,
  enable_monitor: true
});
const result = await engine.execute(plan);
```

### 高级使用

```javascript
// 并行调度多个任务
const { dispatchParallel } = require('./src/agents');
const results = await dispatchParallel([
  { type: 'create', description: '创建用户模块' },
  { type: 'create', description: '创建文章模块' },
  { type: 'integrate', description: '集成模块' }
]);

// 快速任务调度
const { dispatch } = require('./src/agents');
const result = await dispatch({ 
  type: 'architect', 
  description: '设计系统架构' 
});
```

### 进度监控

```javascript
const { ProgressMonitor } = require('./src/monitor');

const monitor = new ProgressMonitor(engine, 8088);
const url = await monitor.start();
console.log(`进度监控面板: ${url}`);
```

## 更新日志

### v2.0 (2026-03-31)
- ✨ **新增 MiniMax MCP 适配器**：集成 MiniMax-M2.7 模型进行智能规划
- ⚡ **新增智能任务调度器**：支持并行执行和智能路由
- 📊 **新增进度监控看板**：Web 界面实时展示执行进度
- 🔧 **新增自动修正系统**：问题分析和自我修复能力
- 🛡️ **新增 Supervisor 监督者**：风险评估和质量检查
