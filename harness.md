# appMaker Harness 总览

appMaker 是一个基于 Harness Engineering 理念构建的 AI Agent 协作系统，让 AI 模型自主完成 APP 的策划、编写、优化、修正全流程，无需人类干预。

## 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                        appMaker                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                     Skills (编排核心)                   │   │
│   ├─────────────────────────────────────────────────────────┤   │
│   │  planning.skill      │ 策划：拆解需求、生成计划          │   │
│   │  execution.skill     │ 执行：任务协调、状态管理          │   │
│   │  supervision.skill   │ 监督：监控进度、触发修正          │   │
│   │  agent-call.skill    │ 调用：opencode/claude-code        │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                     Rules (约束保障)                    │   │
│   ├─────────────────────────────────────────────────────────┤   │
│   │  architecture.rules   │ 分层、模块、依赖约束            │   │
│   │  quality.rules        │ 代码质量、提交规范              │   │
│   │  self-correction.rules│ 修正触发条件、处理流程          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                   外部 Agent 协作                        │   │
│   ├─────────────────────────────────────────────────────────┤   │
│   │          opencode          │      claude-code           │   │
│   │     (快速编码任务)         │    (复杂推理任务)           │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 工作流程

```
用户需求
    │
    ▼
┌──────────────┐
│   planning   │ ←── 输入：自然语言需求
│   .skill     │
└──────────────┘
    │
    │ 生成：任务树、里程碑、计划
    ▼
┌──────────────┐
│  execution   │ ←── 循环执行任务
│   .skill     │
│              │ ←── 调用外部 Agent
│  [opencode]  │    [claude-code]
│              │
└──────────────┘
    │
    │ 验证结果
    ▼
┌──────────────┐
│ supervision  │ ←── 监控进度、质量、资源
│   .skill     │
└──────────────┘
    │
    │ 触发修正
    ▼
┌──────────────┐
│ self-        │ ←── 自我修复
│ correction   │
│   .rules     │
└──────────────┘
    │
    │ 完成
    ▼
  交付物
```

## 目录结构

```
appMaker/
├── .claude/
│   ├── harness.md              ← 本文件
│   ├── skills/
│   │   ├── agent-call.skill.md  ← Agent 调用协议
│   │   ├── planning.skill.md    ← 需求策划
│   │   ├── execution.skill.md   ← 任务执行
│   │   └── supervision.skill.md ← 进度监督
│   └── rules/
│       ├── architecture.rules.md ← 架构约束
│       ├── quality.rules.md     ← 质量规则
│       └── self-correction.rules.md ← 自修正规则
└── (项目代码...)
```

## 核心原则

1. **用约束换自主** — 规则越清晰，AI 能独立完成的越多
2. **共演化** — 随着模型能力提升，Harness 需要持续调整
3. **自动化优先** — 能自动化的不依赖人工
4. **可追溯** — 所有决策有日志，所有变更可回滚

## 使用指南

### 启动新项目

```bash
# 1. 定义需求（自然语言）
echo "创建一个博客系统，支持文章发布和评论" > PROJECT.md

# 2. 启动策划
claude-code --skill planning < PROJECT.md

# 3. 启动执行
claude-code --skill execution --plan output.json

# 4. 监督进度
claude-code --skill supervision --checkpoint cp_001
```

### 检查点管理

```bash
# 创建检查点
/checkpoint create "里程碑1完成"

# 恢复检查点
/checkpoint restore cp_001

# 查看状态
/status
```

## 设计理念

appMaker 的设计遵循 Harness Engineering 的核心思想：

| 传统开发 | appMaker |
|----------|----------|
| 人类写代码 | AI 执行，Harness 编排 |
| Code Review | 自动化质量检查 + Rules |
| 定期重构 | 自修正闭环持续优化 |
| 固定流程 | 可演化的规则系统 |

## 扩展指南

### 添加新 Agent

1. 在 `skills/agent-call.skill.md` 添加 Agent 配置
2. 实现适配器：`agents/<name>.adapter.js`
3. 添加到任务类型映射

### 添加新 Rule

1. 在 `rules/` 创建 `<name>.rules.md`
2. 在相关 Skill 中引用
3. 更新 Lint 配置（如需要）

### 调整流程

1. 修改对应 Skill 的流程图
2. 更新执行循环
3. 调整监督指标
4. 测试新流程

## 参考

- [Harness Engineering 核心概念](./harness.md) - 理论背景
- 各 Skill/Rules 文件 - 具体实现细节
