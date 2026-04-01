# 执行技能

定义如何协调任务执行、管理状态、处理异常。

## 核心特性

### 🔄 智能重试机制

- 网络错误自动重试（指数退避）
- 最多重试 2 次
- 可重试错误：`timeout`, `ECONNRESET`, `rate limit` 等

### ⏱️ 任务超时控制

- 默认超时：300 秒
- 防止任务无限等待
- 超时后自动标记失败

### 🚀 动态并行调度

- 根据依赖关系智能调度
- 最大并发数：3（可配置）
- 自动构建任务依赖图

### 💰 资源预算管理

- Token 消耗实时追踪
- 预算超限自动停止
- 详细的使用报告

## 双 Agent 协作流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    任务执行循环                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  任务输入                                                        │
│      │                                                         │
│      ▼                                                         │
│  ┌─────────────────┐                                            │
│  │ native-coder    │  阶段 1: 编程                              │
│  │ AI 全栈工程师   │    dispatch({ type: 'create' })           │
│  │ + 重试机制     │    + 超时控制                              │
│  └─────────────────┘                                            │
│      │                                                         │
│      │ 代码产出                                                 │
│      ▼                                                         │
│  ┌─────────────────┐                                            │
│  │ native-reviewer │  阶段 2: 代码审查                         │
│  │ 毒舌点评        │    dispatch({ type: 'review' })           │
│  │ - 打分 0-100    │                                           │
│  │ - 找问题        │                                           │
│  └─────────────────┘                                            │
│      │                                                         │
│      ├─ score ≥ 85 ────→ PASS (下一个任务)                    │
│      │                                                         │
│      ├─ score < 85 ────→ 修正循环 (最多 3 次)                 │
│      │                                                         │
│      └─ 3次后仍<85 ──→ needs_human                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

> **评审阈值**：分数 < 85 的代码必须修正，通过后继续。

## 核心执行循环 (engine.js)

```javascript
const { createEngine } = require('./agents');

const engine = createEngine({
  project_root: './project',
  max_review_cycles: 3,
  task_timeout: 300000, // 5分钟超时
  max_retries: 2, // 重试次数
  max_concurrent_tasks: 3, // 最大并发
  token_budget: 100000, // Token 预算
});

const result = await engine.execute(plan);
```

## 配置选项

| 配置项                 | 默认值   | 说明               |
| ---------------------- | -------- | ------------------ |
| `max_review_cycles`    | 3        | 最大评审修正次数   |
| `task_timeout`         | 300000ms | 任务超时时间       |
| `max_retries`          | 2        | Agent 调用重试次数 |
| `max_concurrent_tasks` | 3        | 最大并发任务数     |
| `token_budget`         | 100000   | Token 预算上限     |

## 任务状态

| 状态          | 说明                     |
| ------------- | ------------------------ |
| `pending`     | 等待执行                 |
| `running`     | 执行中（编程或评审）     |
| `done`        | 完成且通过评审           |
| `failed`      | 执行失败（Agent 错误）   |
| `needs_human` | 超过修正次数，需人工介入 |
| `blocked`     | 被阻塞（依赖未满足）     |
| `deadlock`    | 任务依赖无法满足         |

## 修正循环

```
FAIL → 构建修正 prompt → claude-code 修正
                         ↓
                   opencode 重新评审
                         ↓
                   最多 3 次循环
                         ↓
                   3 次后仍 FAIL → needs_human
```

### 修正 prompt 模板

```markdown
修正以下代码中的问题：

任务: {task_description}

需修正的问题:

1. [CRITICAL] {issue_title}
   文件: {file}
   问题: {reason}
   建议: {suggestion}
   ...

请确保所有 CRITICAL 问题必须修复。
```

## 智能并行调度

### 任务依赖图

```javascript
const taskGraph = engine._buildTaskGraph(tasks);
// 自动分析依赖关系
// 支持并行执行无依赖任务
```

### 执行流程

```
里程碑 1: [t1, t2, t3, t4]
  t1 ──┬── t3 ── t4
  t2 ──┘

  t1, t2 可并行（无依赖）
  t3 等待 t1,t2 完成
  t4 等待 t3 完成
```

## Token 追踪

```javascript
// 实时追踪 token 消耗
engine.on('budget:exceeded', ({ usage, budget }) => {
  console.log('预算超限！', usage, budget);
  engine.halt = true;
});

// 获取使用统计
const result = await engine.execute(plan);
console.log(result.tokenUsage);
// {
//   total: 85000,
//   byAgent: {
//     'native-coder': 60000,
//     'native-reviewer': 25000
//   }
// }
```

## 里程碑执行

```javascript
// 智能里程碑执行
for (const milestone of plan.milestones) {
  // 自动并行调度可用任务
  // 等待依赖满足后执行后续任务
  const results = await engine._executeMilestone(milestone, plan);

  // 里程碑结束 → 创建检查点
  await engine._createCheckpoint(`milestone_${milestone.id}`);
}
```

## 并行策略

### 规则

1. **里程碑内任务** → 按依赖串行
2. **独立任务（同依赖级）** → 可并行（最多 3 个并发）
3. **编程后可立即评审** → 串行（评审依赖编程结果）

### 并行度示例

```
里程碑 1: [t1, t2, t3, t4]
  t1 ──┬── t3 ── t4
  t2 ──┘

  t1, t2 可并行
  t3 等待 t1,t2 完成
  t4 等待 t3 完成
```

## 检查点

每个里程碑结束自动创建：

```json
{
  "id": "cp_1234567890",
  "name": "milestone_m1",
  "timestamp": "2026-03-31T...",
  "tasks": {
    "t1": { "status": "done", "result": {...} },
    "t2": { "status": "done", "result": {...} }
  }
}
```

恢复执行：

```javascript
await engine.restore('cp_1234567890');
```

## 上下文传递

```javascript
{
  task_id: 't1',
  project_root: '/path/to/project',
  architecture_rules: '...',  // 从 rules/architecture.rules.md 加载
  quality_rules: '...',        // 从 rules/quality.rules.md 加载
  checkpoint: 'cp_xxx'
}
```

## 异常处理

| 异常              | 处理                       |
| ----------------- | -------------------------- |
| claude-code 超时  | 重试 3 次，仍失败 → failed |
| opencode 评审失败 | 标记 failed                |
| 修正循环超限      | needs_human                |
| Agent 崩溃        | 切换备用（如有）           |

## 进度报告

```
[TASK] t3: 完成
  状态: done ✓
  评审: PASS (85分)
  修正: 0 次

[PROGRESS] 3/11 tasks complete (27%)
  ██████░░░░░░░░░░░░░░░░░
  里程碑 1: 3/3 ✓
  里程碑 2: 0/4 进行中
```

## CLI 使用

```bash
# 健康检查
node cli.js health

# 执行计划
node cli.js execute plan.json

# 查看状态
node cli.js status
```

## 返回格式

```javascript
{
  plan_id: 'blog-system-001',
  status: 'success | partial | failed',
  results: [
    {
      task_id: 't1',
      status: 'done | failed | needs_human',
      verdict: 'PASS | FAIL | CONDITIONAL_PASS',
      score: 85,
      cycles: 0,
      code_result: {...},
      review_result: {...}
    }
  ],
  summary: {
    total: 12,
    done: 11,
    failed: 0,
    needs_human: 1,
    total_review_cycles: 5,
    average_score: 82,
    duration_ms: 180000
  }
}
```
