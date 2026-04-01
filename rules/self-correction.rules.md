# 自修正规则

定义何时及如何触发自修正，形成自我修复闭环。

## 触发条件

| 条件           | 阈值          | 严重程度 | 处理                     |
| -------------- | ------------- | -------- | ------------------------ |
| 质量检查失败   | score < 60    | 🔴 高    | 触发自我修正             |
| 任务超时       | > 2x 预估时间 | 🟡 中    | 分析原因，决定重试或跳过 |
| 错误累积       | > 5 个        | 🔴 高    | 触发自我修正             |
| 资源消耗       | > 80% 预算    | 🟡 中    | 优化或申请更多资源       |
| 计划偏离       | > 20%         | 🔴 高    | 重新规划                 |
| Agent 连续失败 | 3 次          | 🔴 高    | 切换策略或人工介入       |

## 修正类型

### 类型 1：Agent 修正 (agent_fix)

**适用**：质量问题、代码 bug

```
触发条件：评审 score < 60
处理方式：调用修正 Agent
流程：
  1. 构建修正提示词
  2. 调用 native-coder 修正代码
  3. 重新评审
  4. 记录修正历史
```

### 类型 2：重试修正 (retry)

**适用**：网络错误、超时、临时故障

```
触发条件：网络或超时错误
处理方式：延迟重试
流程：
  1. 分析错误类型
  2. 延迟后重试（最多 3 次）
  3. 指数退避策略
  4. 记录失败历史
```

### 类型 3：优化重试 (optimize_and_retry)

**适用**：执行超时

```
触发条件：执行超时
处理方式：优化代码后重试
流程：
  1. 分析超时原因
  2. 优化代码（减少计算、添加缓存）
  3. 重新执行
  4. 验证性能改善
```

### 类型 4：人工介入 (human_intervention)

**适用**：安全问题、架构违规、资源耗尽

```
触发条件：security_vuln / architecture_violation / resource_exhausted
处理方式：标记需要人工处理
流程：
  1. 记录问题详情
  2. 创建检查点
  3. 标记任务状态为 needs_human
  4. 继续其他任务
```

## 问题类型检测

SelfCorrector 自动检测以下问题类型：

| 问题类型               | 检测关键词                     | 严重程度 | 处理策略           |
| ---------------------- | ------------------------------ | -------- | ------------------ |
| quality_issue          | 评审 score < 60                | 🟡       | agent_fix          |
| network_or_timeout     | network, timeout, econnrefused | 🟡       | retry              |
| architecture_violation | architecture, design           | 🔴       | human_intervention |
| security_vuln          | security, injection, xss       | 🔴       | human_intervention |
| resource_exhausted     | token, quota, rate limit       | 🔴       | human_intervention |
| syntax_error           | syntax, parse                  | 🔴       | agent_fix          |
| execution_timeout      | timeout                        | 🟡       | optimize_and_retry |
| code_bug               | 其他错误                       | 🟡       | agent_fix          |

## 修正流程

```
检测到触发条件
        │
        ▼
┌───────────────────────────┐
│  步骤 1：分析根因          │
│  - 查看错误日志            │
│  - 分析失败模式            │
│  - 确定问题类型            │
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│  步骤 2：制定修正计划      │
│  - 选择修正类型            │
│  - 制定具体措施            │
│  - 评估影响范围            │
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│  步骤 3：执行修正          │
│  - 按计划执行修正          │
│  - 记录每步操作            │
│  - 保持其他任务继续         │
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│  步骤 4：验证效果          │
│  - 重新运行质量检查        │
│  - 验证修正是否成功        │
│  - 确认无引入新问题        │
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│  步骤 5：记录经验          │
│  - 更新 rules（如需要）    │
│  - 避免重复犯错            │
│  - 记录到修正日志          │
└───────────────────────────┘
```

## 修正日志格式

```markdown
# 修正记录

## corr_001

- 时间：2026-03-31 14:30
- 任务：t5 - 实现用户认证
- 触发条件：验证失败 > 3 次
- 问题：JWT token 生成逻辑有 bug
- 修正方式：Agent 自我修正
- 修正后：测试通过 ✓
- 教训：需要增加 token 验证的边界测试

## corr_002

- 时间：2026-03-31 16:00
- 任务：t8 - 数据库迁移
- 触发条件：架构违规
- 问题：Service 层直接访问数据库
- 修正方式：重新分层，加入 Repository 层
- 修正后：架构检查通过 ✓
- 教训：需要在 planning 阶段明确分层要求
```

## 降级策略

当自我修正无法解决问题时：

| 情况         | 处理方式                     |
| ------------ | ---------------------------- |
| 少数任务失败 | 跳过，继续其他任务           |
| 核心功能受损 | 暂停，记录状态，等待人工决策 |
| 系统不可用   | 紧急回滚，保留检查点         |
| 资源完全耗尽 | 暂停所有任务，报告人工       |

## 自我修正与人工介入的边界

```javascript
// 需要人工介入的情况
const NEEDS_HUMAN = [
  '安全漏洞', // 安全问题
  '数据丢失风险', // 不可逆操作
  '架构重大变更', // 超出当前理解范围
  '连续修正失败 > 3', // 多次失败
  '资源耗尽', // 需要外部资源
];
```

```javascript
// 自我修正处理
const CAN_SELF_CORRECT = ['简单逻辑错误', '测试用例遗漏', '边界情况遗漏', '小范围重构', '配置错误'];
```

## 修正效果评估

每次修正后评估：

| 指标       | 目标             |
| ---------- | ---------------- |
| 修正成功率 | > 80%            |
| 修正时间   | < 原任务预估时间 |
| 引入新问题 | 0                |
| 重复犯错   | 0                |

## API 接口

### SelfCorrector 类

```javascript
import { SelfCorrector } from './corrector.js';

const corrector = new SelfCorrector(engine);
```

### correct(triggerReason, context)

主修正方法，根据触发原因执行相应的修正策略。

```javascript
const result = await corrector.correct('quality_low', {
  task: { id: 't1', description: '实现登录功能' },
  score: 45,
  issues: [
    {
      severity: 'CRITICAL',
      title: 'XSS漏洞',
      file: 'login.js',
      reason: '未转义用户输入',
      suggestion: '使用 htmlspecialchars',
    },
  ],
});

console.log(result);
// {
//   success: true,
//   action: 'agent_fix',
//   cause: { type: 'quality_issue', message: 'Score too low: 45', severity: '🟡' },
//   result: { status: 'fix_completed', files_created: ['login.js'] },
//   timestamp: '2026-04-01T12:00:00.000Z'
// }
```

### correctTask(taskId, issues, context)

快捷方法，用于修正指定任务。

```javascript
const result = await corrector.correctTask('t1', ['缺少错误处理', '变量命名不规范'], { score: 50 });
```

### handleExecutionError(error, taskId, context)

处理执行错误。

```javascript
try {
  await someOperation();
} catch (error) {
  const result = await corrector.handleExecutionError(error, 't1', {
    description: '数据库查询',
  });
}
```

## 修正结果结构

```typescript
interface CorrectionResult {
  success: boolean; // 修正是否成功
  action: string; // 修正动作: 'agent_fix' | 'retry' | 'optimize_and_retry' | 'human_intervention'
  cause: {
    type: string; // 问题类型
    message: string; // 问题描述
    severity: string; // 严重程度: '🟢' | '🟡' | '🔴'
    details?: object; // 额外详情
  };
  result: {
    status: string; // 执行状态
    files_created?: string[]; // 创建的文件
    files_modified?: string[]; // 修改的文件
    error?: string; // 错误信息（如有）
  };
  timestamp: string; // 时间戳
}
```

## 修正日志

修正记录保存在 `corrections.log` 文件中：

```
[INFO] 修正记录 [corr_1774975841865] - 任务: t1 | 触发: quality_low | 问题: Score too low: 50 (quality_issue) | 动作: fix_dispatched | 验证: 成功
[ERROR] Correction unresolved, requires human intervention for task: t3 (security_vuln)
```
