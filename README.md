# appMaker

AI 驱动的 APP 开发系统。核心理念：**claude-code 编程 + opencode 毒舌点评**。

## 角色分工

| Agent           | 职责                | 模式  |
| --------------- | ----------------- | --- |
| **claude-code** | 编程（写代码）           | 执行者 |
| **opencode**    | 毒舌点评（Code Review） | 评审者 |

## 双 Agent 协作流程

```
claude-code 写代码
       ↓
opencode 毒舌点评（必须找到 3+ 问题）
       ↓
  ├─ PASS → 继续下一个任务
  └─ FAIL → claude-code 修正（最多 3 次）
                   ↓
            3 次后仍 FAIL → 人工介入
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
| `node cli.js run "需求"`       | 自动生成计划并执行（推荐）      |

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
│   ├── planner.js        # 需求 → 计划
│   ├── engine.js         # 执行引擎
│   └── agents/           # Agent 适配器
├── rules/                # 约束规则
├── skills/               # 技能定义
├── config/               # 配置文件
└── plans/                # 生成的计划存放
```

## 配置

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
    }
  }
}
```

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
    { "id": "t1", "description": "初始化项目结构", "agent": "claude-code", ... }
  ],
  "metadata": {
    "total_tasks": 8,
    "estimated_tokens": 15000,
    "total_minutes_estimate": 60
  }
}
```

## API 使用

```javascript
const { createEngine, createPlanner, healthCheck } = require('./src/agents');

// 健康检查
const status = await healthCheck();

// 生成计划
const planner = createPlanner({ project_root: './' });
const plan = await planner.plan('做一个博客系统');

// 执行计划
const engine = createEngine({ project_root: './' });
const result = await engine.execute(plan);
```
