# 质量规则

定义代码质量和提交规范，确保交付物可维护、可测试。

## 代码质量规则

### 错误处理

```javascript
// ✗ 禁止：bare try-catch
try {
  doSomething();
} catch (e) {
  // 什么都没做
}

// ✗ 禁止：吞掉错误
try {
  doSomething();
} catch (e) {
  console.log('error'); // 静默处理
}

// ✓ 正确：具体处理
try {
  doSomething();
} catch (e) {
  logger.error('操作失败', { error: e, context });
  throw new UserFriendlyError('操作失败，请稍后重试');
}

// ✓ 正确：可选的错误类型
try {
  doSomething();
} catch (e) {
  if (e instanceof ValidationError) {
    return res.status(400).json({ error: e.message });
  }
  throw e; // 其他错误继续抛出
}
```

### 测试覆盖

| 代码类型     | 最低覆盖率 | 说明                     |
| ------------ | ---------- | ------------------------ |
| 核心业务逻辑 | ≥ 80%      | Service 层核心函数       |
| 工具函数     | ≥ 90%      | utils/ 中的公共函数      |
| API 路由     | 100%       | 所有 endpoint 必须有测试 |
| 边界情况     | 必须覆盖   | 空值、异常值、超大值     |

### 代码可读性

```javascript
// ✗ 禁止：魔法数字
if (user.age > 18) { ... }
setTimeout(doSomething, 86400000);

// ✓ 正确：有名字的常量
const MINIMUM_AGE = 18;
const ONE_DAY_MS = 86400000;
if (user.age > MINIMUM_AGE) { ... }
setTimeout(doSomething, ONE_DAY_MS);
```

```javascript
// ✗ 禁止：复杂三元嵌套
const result = a ? (b ? (c ? d : e) : f) : g;

// ✓ 正确：拆分为变量或函数
const getDefaultValue = (a, b, c) => {
  if (a) return b ? c : d;
  return g;
};
```

## 提交规范

### Commit Message 格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

| type     | 说明      |
| -------- | --------- |
| feat     | 新功能    |
| fix      | Bug 修复  |
| docs     | 文档更新  |
| style    | 格式调整  |
| refactor | 重构      |
| test     | 测试相关  |
| chore    | 构建/工具 |

```bash
# 正确示例
feat(auth): 添加 JWT 刷新机制

- 支持 access token 过期前自动刷新
- 刷新失败后引导用户重新登录

Closes #123
```

### 提交前检查清单

每个 commit 必须通过：

- [ ] 代码格式化（prettier/eslint）
- [ ] Lint 检查通过
- [ ] 单元测试通过
- [ ] 增量测试覆盖（如果改了核心逻辑）
- [ ] commit message 格式正确

## API 质量规则

### 请求验证

```javascript
// ✗ 禁止：不验证输入
app.post('/users', (req, res) => {
  const user = req.body; // 直接使用
  db.save(user);
});

// ✓ 正确：验证输入
app.post(
  '/users',
  [
    body('email').isEmail(),
    body('name').isLength({ min: 1, max: 100 }),
    body('age').optional().isInt({ min: 0 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const user = req.body;
    db.save(user);
  },
);
```

### 响应格式

```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "ISO",
    "version": "1.0"
  }
}
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "邮箱格式不正确",
    "details": [...]
  }
}
```

## 代码审查规则

### 必须审查的情况

- 所有 PR 必须经过审查
- 核心模块变更（认证、支付、数据层）
- 任何新依赖的添加
- 任何安全相关的变更

### 审查关注点

1. **功能性**：代码是否实现需求
2. **正确性**：边界情况是否处理
3. **可维护性**：未来修改是否容易
4. **测试**：是否有适当测试
5. **性能**：是否有性能问题

## 质量门禁

```
┌─────────────────────────────────────────────┐
│              Quality Gate                   │
├─────────────────────────────────────────────┤
│  1. Lint 检查          ✓ 必须通过            │
│  2. 单元测试           ✓ 必须通过            │
│  3. 集成测试           ✓ 必须通过            │
│  4. 覆盖率检查         ✓ > 80%              │
│  5. 安全扫描           ✓ 必须通过            │
│  6. 架构检查           ✓ 无违规             │
├─────────────────────────────────────────────┤
│  全部通过 → 允许合并                          │
│  任一失败 → 阻止合并                          │
└─────────────────────────────────────────────┘
```
