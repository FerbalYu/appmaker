# Agent 适配器

appMaker 的 Agent 调用层。核心理念：**claude-code 编程，opencode 毒舌点评**。

## 角色分工

| Agent | 职责 | 特点 |
|-------|------|------|
| **claude-code** | 编程（写代码） | 复杂推理、架构设计、深度分析 |
| **opencode** | 毒舌点评（Code Review） | 快速反馈、犀利批评、质量把控 |

## 目录结构

```
agents/
├── index.js              # 主入口
├── base.js              # AgentAdapter 基类
├── opencode.js           # 毒舌点评适配器
├── claude-code.js       # 编程适配器
├── dispatcher.js         # 智能调度器
├── config.json          # 配置文件
└── README.md
```

## 工作流程

```
用户需求
    │
    ▼
┌─────────────────┐
│  claude-code    │ ← 编程
│  (写代码)        │
└─────────────────┘
    │ 产出代码
    ▼
┌─────────────────┐
│  opencode       │ ← 毒舌点评
│  (挑毛病)        │
└─────────────────┘
    │ 评审反馈
    ▼
┌─────────────────┐
│  claude-code    │ ← 修正
│  (根据反馈改)    │
└─────────────────┘
    │
    ├── PASS → 继续下一个任务
    └── FAIL → 继续点评，直到通过
```

## 快速使用

```javascript
const { dispatch } = require('./agents');

// 编程任务 → claude-code
const codeResult = await dispatch({
  id: 't1',
  type: 'create',
  description: '实现用户注册功能',
  files: ['src/models/']
});

// 评审任务 → opencode
const reviewResult = await dispatch({
  id: 'r1',
  type: 'review',
  description: '评审用户注册代码',
  files: ['src/auth/register.js']
});
```

## 任务类型

### claude-code（编程）

| 类型 | 说明 |
|------|------|
| `create` | 创建新模块/文件 |
| `modify` | 修改现有代码 |
| `architect` | 架构设计 |
| `debug` | 调试复杂 bug |
| `refactor` | 重构 |
| `auth/security` | 认证和安全相关 |

### opencode（评审）

| 类型 | 说明 |
|------|------|
| `review` | 代码评审 |
| `test` | 测试用例评审 |
| `docs` | 文档评审 |

## 评审结果格式

```javascript
{
  task_id: 'r1',
  agent: 'opencode',
  type: 'review',
  status: 'completed',
  output: {
    verdict: 'PASS | FAIL | CONDITIONAL_PASS',
    score: 85,
    issues: [
      {
        severity: 'CRITICAL | WARNING | INFO',
        file: 'src/auth/register.js',
        line: '42',
        title: 'SQL 注入风险',
        reason: '直接拼接用户输入',
        suggestion: '使用参数化查询'
      }
    ],
    summary: '代码整体可接受，但有三处安全隐患',
    compliments: '错误处理做得不错'
  }
}
```

## 配置

编辑 `config.json`：

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

## 扩展评审规则

在 `context` 中传入额外规则：

```javascript
dispatch({
  type: 'review',
  description: '评审这个模块',
  context: {
    architecture_rules: '模块间不能循环依赖',
    quality_rules: '所有 public 函数必须有 JSDoc'
  }
});
```

## 健康检查

```javascript
const { healthCheck } = require('./agents');

const status = await healthCheck();
// { 'claude-code': true, opencode: true }
```
