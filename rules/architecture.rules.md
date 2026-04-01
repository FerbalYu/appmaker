# 架构规则

强制执行的架构约束，确保代码结构健康、可维护。

## 分层约束

```
┌─────────────────────────────────────────────┐
│                  UI Layer                    │
│         (React/Vue/Flutter 组件)            │
├─────────────────────────────────────────────┤
│               API Layer                      │
│           (Router, Controller)               │
├─────────────────────────────────────────────┤
│             Service Layer                    │
│          (Business Logic)                   │
├─────────────────────────────────────────────┤
│              Data Layer                      │
│        (Repository, ORM, Cache)              │
├─────────────────────────────────────────────┤
│             External Services                │
│         (Database, API, Files)              │
└─────────────────────────────────────────────┘

规则：
✓ 上层可以调用下层
✗ 下层不能调用上层
✗ 同层之间避免直接依赖
```

### 依赖方向规则

- UI 层 → API 层 → Service 层 → Data 层 → External
- **禁止逆流**：Data 层不能直接被 UI 层调用
- **共享模块**：独立于层级之外，如 `utils/`、`types/`

## 模块约束

### 模块通信规则

```
模块 A                    模块 B
   │                        │
   │───── Interface ────────│
   │    (定义在 A 或共享)     │
   │                        │
   ▼                        ▼
 不能直接 import          不能直接 import
 B 的内部文件            A 的内部文件
```

### 循环依赖禁止

```javascript
// ✗ 禁止：循环依赖
// a.js
import { b } from './b';

// b.js
import { a } from './a';
```

```javascript
// ✓ 正确：通过中介者或重构
// a.js
import { mediator } from './mediator';

// b.js
import { mediator } from './mediator';
```

### 模块 Owner 注释

每个独立模块根目录必须有 Owner 注释：

```markdown
<!--
  Owner: [模块负责人/Agent名]
  Created: 2026-03-31
  Purpose: [模块用途简短描述]
-->
```

## 文件约束

| 约束       | 限制                       | 原因           |
| ---------- | -------------------------- | -------------- |
| 单文件行数 | ≤ 500 行                   | 易于阅读和维护 |
| 函数长度   | ≤ 50 行                    | 单一职责       |
| 参数数量   | ≤ 4 个                     | 减少复杂度     |
| 嵌套深度   | ≤ 3 层                     | 避免深层嵌套   |
| 文件名     | 小写 + 下划线 / kebab-case | 统一风格       |

### 规则检查示例

```javascript
// ✗ 违反：函数太长
function processUserData(data) {
  let result = {};
  // 100 行处理逻辑...
  return result;
}

// ✓ 正确：拆分为多个小函数
function processUserData(data) {
  const validated = validateData(data);
  const normalized = normalizeData(validated);
  const enriched = enrichData(normalized);
  return enriched;
}
```

## 配置约束

- 配置文件格式：`JSON` / `YAML` / `TOML`
- 禁止硬编码：
  - API 地址
  - 密钥/Token
  - 超时时间
  - 并发数
- 所有配置必须：
  - 放在 `config/` 或 `.env`
  - 有类型定义（Schema）
  - 有默认值

## 命名约束

| 类型     | 规则                     | 示例              |
| -------- | ------------------------ | ----------------- |
| 文件名   | 小写下划线               | `user_service.js` |
| 类名     | 大驼峰                   | `UserService`     |
| 函数名   | 小驼峰                   | `getUserById`     |
| 常量     | 全大写                   | `MAX_RETRY_COUNT` |
| 私有成员 | 下划线前缀               | `_privateMethod`  |
| 测试文件 | `.test.js` 或 `_test.js` | `user.test.js`    |

## 架构违规处理

| 违规类型   | 处理方式            |
| ---------- | ------------------- |
| 分层违规   | Lint 报错，拒绝合并 |
| 循环依赖   | Lint 报错，拒绝合并 |
| 文件过长   | Lint 警告，提醒拆分 |
| 硬编码配置 | Lint 报错，必须修复 |

## Lint 规则文件

架构规则应编码为 Lint 规则：

```json
// .eslintrc.architectural-rules.json
{
  "rules": {
    "no-circular-dependency": "error",
    "layer-imports": [
      "error",
      {
        "allowedLayers": ["ui->api", "api->service", "service->data"]
      }
    ],
    "max-file-lines": ["warn", 500],
    "max-function-length": ["warn", 50],
    "no-hardcoded-config": "error"
  }
}
```
