# AGENTS.md

appMaker 项目的 AI Agent 工作手册。本文件是项目的"地图"，指向详细文档。

## 项目概述

**appMaker** — AI 驱动的 APP 开发系统。核心理念：让 AI 自主完成从策划到交付的全流程，无需人类干预。

## 项目结构地图

```
appMaker/
├── harness.md              ← 项目总览、架构图、工作流程
├── AGENTS.md              ← 本文件（地图）
├── cli.js                 ← 命令行入口
├── src/                   ← 执行引擎与核心逻辑
├── skills/                ← 技能定义
│   ├── planning.skill.md    → 如何策划和拆解需求
│   ├── execution.skill.md   → 如何执行和管理任务
│   ├── supervision.skill.md → 如何监控进度和质量
│   └── agent-call.skill.md  → 如何调用外部 Agent
└── rules/                  ← 约束规则
    ├── architecture.rules.md → 架构分层和模块约束
    ├── quality.rules.md     → 代码质量和提交规范
    └── self-correction.rules.md → 自我修正流程
```

## 快速开始

### 新任务流程

```
1. 理解需求 → 阅读 PROJECT.md 或用户输入
2. 制定计划 → 调用 planning.skill
3. 执行任务 → 使用 execution.skill
4. 监督质量 → 使用 supervision.skill
5. 自我修正 → 根据 self-correction.rules 触发
```

### 关键决策点

| 情况 | 查看文档 |
|------|----------|
| 如何拆解需求 | `skills/planning.skill.md` |
| 如何调用外部 Agent | `skills/agent-call.skill.md` |
| 任务执行顺序 | `skills/execution.skill.md` |
| 进度监控方式 | `skills/supervision.skill.md` |
| 架构违规怎么办 | `rules/architecture.rules.md` |
| 质量不达标怎么办 | `rules/quality.rules.md` |
| 如何触发自我修正 | `rules/self-correction.rules.md` |

## Agent 协作模式

### 内部 Agent（appMaker 内置）

| Agent | 职责 | 配置文件 |
|-------|------|----------|
| Planner | 需求理解、任务分解 | `planning.skill.md` |
| Executor | 任务调度、执行协调 | `execution.skill.md` |
| Supervisor | 进度监控、质量检查 | `supervision.skill.md` |
| Corrector | 问题分析、自我修正 | `self-correction.rules.md` |

### 外部 Agent（调用）

| Agent | 调用条件 | 用途 |
|-------|----------|------|
| opencode | 简单任务、独立模块 | 快速实现 CRUD、模板代码 |
| claude-code | 复杂任务、架构设计 | 需要深度推理的工作 |

## 工作原则

1. **遵循规则** — 所有操作必须符合 `rules/` 下的约束
2. **可观测** — 所有状态变化必须记录到日志
3. **可回滚** — 关键操作前创建检查点
4. **不自创** — 不在规则外自行决定，优先查文档

## 常用命令

```bash
# 生成计划
bun cli.js plan <需求描述>

# 执行计划
bun cli.js execute <plan.json>

# 自动生成并执行
bun cli.js run <需求描述>

# 检查Agent状态
bun cli.js health
```

## 错误处理

遇到错误时：
1. 查看 `rules/self-correction.rules.md` 的触发条件
2. 按流程执行修正
3. 记录到修正日志
4. 如果无法修正，标记需要人工介入

## 更新日志

- 2026-03-31: 初始版本，包含基础 Skills 和 Rules
