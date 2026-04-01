# AGENTS.md

appMaker 项目的 AI Agent 工作手册。定义各 Agent 的职责边界、协作协议和交互规范。

---

## 概述

appMaker 采用 Multi-Agent 协作架构，通过明确的职责分工实现从需求到交付的自动化流程。

### Agent 角色矩阵

| Agent              | 类型   | 核心职责                       | 调用时机       |
| ------------------ | ------ | ------------------------------ | -------------- |
| **Planner**        | 规划型 | 需求解析、任务分解、里程碑生成 | 用户提交需求时 |
| **NativeCoder**    | 执行型 | 调用大模型生成代码             | 任务执行阶段   |
| **NativeReviewer** | 评审型 | 代码质量评估、问题定位         | 代码生成后     |
| **Supervisor**     | 监控型 | 进度追踪、风险评估             | 全流程监控     |
| **Corrector**      | 修正型 | 根因分析、自动修复             | 评审失败时     |
| **Daemon**         | 支撑型 | 状态持久化、断点恢复           | 全流程后台运行 |

---

## Agent 职责详解

### Planner（规划 Agent）

**目标**：将自然语言需求转化为可执行的计划

**输入**：

- 用户需求描述（自然语言）
- 项目上下文（如有）

**输出**：

```json
{
  "tasks": [{ "id": "task-1", "description": "...", "agent": "native-coder", "dependencies": [] }],
  "milestones": [{ "id": "m1", "name": "基础框架", "tasks": ["task-1", "task-2"] }],
  "dependencies": { "task-2": ["task-1"] }
}
```

**执行流程**：

1. 解析需求意图
2. 识别核心功能模块
3. 拆解任务依赖图
4. 生成里程碑节点
5. 路由到合适的执行 Agent

---

### NativeCoder（编程 Agent）

**目标**：根据任务描述生成高质量代码

**输入**：

```json
{
  "task_id": "task-1",
  "description": "创建用户认证模块",
  "context": { "framework": "Vue 3", "features": ["登录", "注册", "Token 管理"] }
}
```

**输出**：

```json
{
  "task_id": "task-1",
  "status": "success",
  "files": [{ "path": "src/auth/login.vue", "action": "create", "content": "..." }],
  "artifacts": { "token": "jwt-handler" }
}
```

**执行流程**：

1. 接收任务描述
2. 补充上下文（如有）
3. 调用大模型 API 生成代码
4. 返回生成的文件列表

---

### NativeReviewer（评审 Agent）

**目标**：评估代码质量、发现问题、提供改进建议

**输入**：

```json
{
  "task_id": "task-1",
  "files": [{ "path": "src/auth/login.vue", "content": "..." }],
  "rules": ["quality.rules", "architecture.rules"]
}
```

**输出**：

```json
{
  "task_id": "task-1",
  "status": "pass|fail|warn",
  "issues": [
    { "severity": "error", "location": "src/auth/login.vue:15", "message": "...", "fixable": true }
  ],
  "suggestions": ["考虑使用 composable 提取逻辑"]
}
```

**评审维度**：
| 维度 | 说明 |
|------|------|
| **正确性** | 逻辑正确、无运行时错误 |
| **安全性** | 无注入、XSS、越权等漏洞 |
| **可维护性** | 代码结构清晰、无重复 |
| **性能** | 无明显性能问题 |
| **规范** | 符合 architecture.rules |

---

### Supervisor（监控 Agent）

**目标**：实时监控执行状态，评估风险，触发熔断

**监控指标**：

| 指标         | 阈值    | 处理              |
| ------------ | ------- | ----------------- |
| Token 使用量 | 100,000 | 🔴 停止接受新任务 |
| 连续错误数   | 5       | 🔴 标记人工介入   |
| 任务超时     | 120s    | 🟡 重试或跳过     |
| 进度停滞     | 60s     | 🟡 告警           |

**事件触发**：

- `task:start` — 任务开始
- `task:progress` — 任务进度更新
- `task:done` — 任务完成
- `task:fail` — 任务失败
- `risk:warning` — 风险告警
- `risk:critical` — 严重风险

---

### Corrector（修正 Agent）

**目标**：分析失败原因，生成修复方案，执行修正

**输入**：

```json
{
  "task_id": "task-1",
  "failure": {
    "type": "review_fail",
    "issues": [{ "severity": "error", "message": "..." }]
  }
}
```

**执行流程**：

```
┌──────────────────────────────────────────────┐
│                 修正流程                        │
├──────────────────────────────────────────────┤
│                                               │
│  1. 根因分析                                  │
│     └── 分析评审失败的根本原因                  │
│                                               │
│  2. 方案生成                                  │
│     └── 生成修复方案或替代方案                 │
│                                               │
│  3. 方案评估                                  │
│     └── 检查是否引入新问题                     │
│                                               │
│  4. 执行修正                                  │
│     └── 重新调用 NativeCoder                  │
│                                               │
│  5. 重新评审                                  │
│     └── 再次调用 NativeReviewer               │
│                                               │
│  ↺ 循环（最多 max_review_cycles 次）          │
│                                               │
└──────────────────────────────────────────────┘
```

---

## 协作协议

### 任务流转

```
Planner ──► Engine ──► Dispatcher ──► NativeCoder
                │                         │
                │                         ▼
                │                   NativeReviewer
                │                         │
                ▼                         │
            Supervisor ──────────────────►│
                │                         │
                ▼                         │
            Corrector ◄──────────────────┘
                │
                ▼
            Daemon（持久化）
```

### 消息格式

所有 Agent 间通信使用统一的消息格式：

```typescript
interface AgentMessage {
  id: string; // 消息唯一 ID
  type: string; // 消息类型
  from: string; // 发送方 Agent
  to: string; // 接收方 Agent（可选，广播时为空）
  payload: any; // 消息内容
  timestamp: number; // 时间戳
  metadata?: {
    sessionId?: string;
    taskId?: string;
    retryCount?: number;
  };
}
```

### 事件流

| 事件             | 发送方         | 接收方         | 说明         |
| ---------------- | -------------- | -------------- | ------------ |
| `task:submit`    | Planner        | Engine         | 提交新任务   |
| `task:dispatch`  | Engine         | Dispatcher     | 调度任务     |
| `task:execute`   | Dispatcher     | NativeCoder    | 执行任务     |
| `code:generated` | NativeCoder    | Engine         | 代码生成完成 |
| `review:request` | Engine         | NativeReviewer | 请求评审     |
| `review:result`  | NativeReviewer | Engine         | 评审结果     |
| `fix:request`    | Engine         | Corrector      | 请求修正     |
| `fix:complete`   | Corrector      | Engine         | 修正完成     |

---

## Agent 调用规则

### 调用顺序

1. **Planner** — 项目启动时调用一次
2. **NativeCoder** — 按任务依赖顺序调用
3. **NativeReviewer** — 每个任务完成后调用
4. **Supervisor** — 全程后台监控
5. **Corrector** — 仅在评审失败时调用

### 并发控制

- `dispatcher.max_concurrent_agents: 3` — 最大并发 Agent 数
- 同类型 Agent 禁止并发执行同一任务
- 不同任务可并行执行（遵守依赖关系）

### 超时处理

| Agent          | 默认超时 | 超时处理    |
| -------------- | -------- | ----------- |
| Planner        | 60s      | 重试 2 次   |
| NativeCoder    | 120s     | 重试 3 次   |
| NativeReviewer | 60s      | 重试 2 次   |
| Corrector      | 90s      | 仅重试 1 次 |

---

## 工作原则

### 必须遵守

1. **职责边界** — 每个 Agent 只做职责范围内的事
2. **可追溯** — 所有状态变更必须记录日志
3. **可恢复** — 关键操作前保存检查点
4. **早失败** — 发现问题立即上报，不隐瞒

### 禁止行为

1. **禁止越权** — 不在自身职责外自行决定
2. **禁止静默失败** — 所有失败必须有明确原因
3. **禁止循环依赖** — 任务间不许形成环
4. **禁止主目录操作** — 禁止在用户主目录下创建文件

---

## 常用命令

```bash
# 生成计划
bun cli.js plan <需求描述>

# 执行计划
bun cli.js execute plans/plan_<timestamp>.json

# 自动生成并执行
bun cli.js run <需求描述>

# 检查 Agent 状态
bun cli.js health

# 禁用守护进程模式
bun cli.js run <需求描述> --no-daemon
```

---

## 错误处理

### 错误分类

| 错误类型 | 严重度  | 处理策略       |
| -------- | ------- | -------------- |
| 语法错误 | ⚪ 普通 | 修正后重试     |
| 逻辑错误 | ⚪ 普通 | 修正后重试     |
| 评审失败 | ⚪ 普通 | 触发修正循环   |
| 资源耗尽 | 🔴 严重 | 停止并标记人工 |
| 安全违规 | 🔴 严重 | 立即停止       |
| 超时     | 🟡 一般 | 重试或跳过     |

### 错误处理流程

```
错误发生
    │
    ▼
┌──────────────────┐
│  记录错误日志     │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  判断错误类型     │
└────────┬─────────┘
         │
    ┌────┴────┐
    ▼         ▼
  🔴 严重    ⚪ 普通
    │         │
    ▼         ▼
 立即停止   检查重试次数
 标记人工   │
            ▼
        重试或跳过
```

---

## 文档索引

| 文档                                           | 说明           |
| ---------------------------------------------- | -------------- |
| [harness.md](./harness.md)                     | 系统架构设计   |
| [README.md](./README.md)                       | 项目快速入门   |
| [skills/\*](./skills/)                         | 各技能详细定义 |
| [rules/\*](./rules/)                           | 约束规则       |
| [src/agents/README.md](./src/agents/README.md) | Agent 实现细节 |

---

## 更新日志

| 日期       | 变更                                |
| ---------- | ----------------------------------- |
| 2026-03-31 | 初始版本，定义 Agent 职责与协作协议 |
