# Agent 调用技能

定义如何调用外部 Agent 完成工程任务。

## 核心分工

| Agent           | 职责                    | 模式   |
| --------------- | ----------------------- | ------ |
| **claude-code** | 编程（写代码）          | 执行者 |
| **opencode**    | 毒舌点评（Code Review） | 评审者 |

## 双 Agent 协作流程

```
┌─────────────────────────────────────────────────────────────────┐
│                     双 Agent 协作模式                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   用户需求                                                       │
│       │                                                         │
│       ▼                                                         │
│   ┌───────────────┐                                             │
│   │ claude-code   │  ← 编程模式                                 │
│   │  写代码       │     实现功能                                 │
│   └───────────────┘                                             │
│       │                                                         │
│       │ 产出代码                                                 │
│       ▼                                                         │
│   ┌───────────────┐                                             │
│   │ opencode      │  ← 毒舌点评模式                              │
│   │  挑毛病       │     • 必须找到至少 3 个问题                   │
│   │               │     • 批评有建设性                           │
│   │               │     • 打分 0-100                             │
│   └───────────────┘                                             │
│       │                                                         │
│       │ 评审结果                                                 │
│       ├─ PASS ────────────→ 下一个任务                           │
│       ├─ FAIL ───────────→ 返回 claude-code 修正                │
│       └─ CONDITIONAL ───→ 部分通过，继续监控                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 评审 prompt 模板

opencode（评审）使用的 prompt 结构：

```markdown
【毒舌评审模式】

你要对以下代码/变更进行犀利点评。

## 评审任务

{task_description}

## 需要评审的文件

{file_list}

## 评审维度

1. 逻辑问题 — 有 bug 吗？边界情况处理了吗？
2. 安全漏洞 — 有 SQL 注入/XSS/敏感信息泄露风险吗？
3. 性能隐患 — 循环嵌套、N+1 查询、内存泄漏？
4. 代码风格 — 命名诡异、函数太长、注释缺失？
5. 可维护性 — 改需求时会不会改到吐血？

## 输出格式

{
"verdict": "PASS | FAIL | CONDITIONAL_PASS",
"score": 0-100,
"issues": [...],
"summary": "一句话总结",
"compliments": "亮点（找不到就说'没有'）"
}

## 毒舌规则

- 必须找到至少 3 个问题
- 批评要有建设性
- 适当调侃，但不能说脏话
```

## 评审结果处理

| verdict            | 含义             | 处理方式                        |
| ------------------ | ---------------- | ------------------------------- |
| `PASS`             | 质量合格         | 继续下一个任务                  |
| `FAIL`             | 存在严重问题     | 返回 claude-code 修正后重新评审 |
| `CONDITIONAL_PASS` | 基本合格但需关注 | 记录问题，继续监控              |

### 修正循环

```
FAIL → claude-code 修正 → opencode 重新评审
                    ↓
              最多 3 次循环
                    ↓
              3 次后仍 FAIL → 人工介入
```

## 调用协议

### 1. claude-code 编程调用

```javascript
dispatch({
  id: 't1',
  type: 'create',
  description: '实现用户认证模块',
  files: ['src/models/user.js', 'src/auth/'],
  context: {
    architecture_rules: '...',
    quality_rules: '...',
  },
});
```

### 2. opencode 评审调用

```javascript
dispatch({
  id: 'r1',
  type: 'review',
  description: '评审用户认证模块代码',
  files: ['src/auth/'],
  context: {
    architecture_rules: '模块间不能循环依赖',
    quality_rules: '所有 public 函数必须有 JSDoc',
  },
});
```

### 3. 批量编程 + 评审

```javascript
// 先批量编程
const codeResults = await dispatch([
  { id: 't1', type: 'create', description: '模块 A' },
  { id: 't2', type: 'create', description: '模块 B' },
  { id: 't3', type: 'create', description: '模块 C' },
]);

// 再批量评审
const reviewResults = await dispatch([
  { id: 'r1', type: 'review', description: '评审模块 A', files: ['src/a/'] },
  { id: 'r2', type: 'review', description: '评审模块 B', files: ['src/b/'] },
  { id: 'r3', type: 'review', description: '评审模块 C', files: ['src/c/'] },
]);
```

## 任务类型映射

| type        | 分配给      | 说明          |
| ----------- | ----------- | ------------- |
| `create`    | claude-code | 创建文件/模块 |
| `modify`    | claude-code | 修改代码      |
| `architect` | claude-code | 架构设计      |
| `debug`     | claude-code | 调试          |
| `review`    | opencode    | 代码评审      |
| `test`      | opencode    | 测试评审      |
| `docs`      | opencode    | 文档评审      |

## 上下文传递

每个调用需携带：

| 字段           | 说明               |
| -------------- | ------------------ |
| `task_id`      | 任务唯一标识       |
| `project_root` | 项目根路径         |
| `rules`        | 当前激活的规则引用 |
| `checkpoint`   | 检查点（用于恢复） |

## 错误处理

| 错误类型     | 处理                                   |
| ------------ | -------------------------------------- |
| Agent 超时   | claude-code 重试 3 次，opencode 不重审 |
| Agent 不可用 | 切换到备用 Agent                       |
| 连续评审失败 | 人工介入                               |

## 成本优化

- **claude-code**：贵，但用得值（复杂任务）
- **opencode**：便宜，用于评审
- **并行策略**：多个独立编程任务可并行 → 评审串行
