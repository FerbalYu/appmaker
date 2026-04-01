# Persistent Daemon - 持久守护进程

一个具备「持久生命」的自主守护进程，支持后台 agent 会话、记忆整合和进程永生。

## 核心特性

- 🔄 **持久化运行** - 支持进程重启后的状态恢复
- 🧠 **记忆整合** - 三层记忆系统（语义、情景、程序）
- 💾 **会话管理** - 多会话并发、自动超时管理
- 📋 **任务队列** - 优先级调度、依赖管理、自动重试
- 💓 **心跳保活** - 自动健康检查、故障自恢复
- 🎯 **插件化架构** - 生命周期钩子、灵活扩展

## 架构设计

```
┌─────────────────────────────────────────┐
│           Persistent Daemon             │
├─────────────────────────────────────────┤
│  ┌─────────────────────────────────┐    │
│  │      DaemonCore (生命周期)       │    │
│  │  - 心跳保活 (30s)                │    │
│  │  - 自动保存 (60s)                │    │
│  │  - 状态恢复                      │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ┌──────────┐ ┌──────────┐ ┌────────┐  │
│  │ Memory   │ │ Session  │ │ Task   │  │
│  │ Store    │ │ Manager  │ │ Queue  │  │
│  │          │ │          │ │        │  │
│  │ 语义记忆 │ │ 会话管理 │ │ 任务   │  │
│  │ 情景记忆 │ │ 上下文   │ │ 优先级 │  │
│  │ 程序记忆 │ │ 历史记录 │ │ 依赖   │  │
│  └──────────┘ └──────────┘ └────────┘  │
└─────────────────────────────────────────┘
```

## 快速开始

### 基本使用

```javascript
import { createDaemon } from './src/daemon/index.js';

const daemon = await createDaemon({
  dataDir: './.daemon',
  heartbeatInterval: 30000,
  autoSaveInterval: 60000,
});

await daemon.start();

// 创建会话
const session = await daemon.createSession({
  name: 'my-agent',
  mode: 'background',
});

// 发送消息
await daemon.getSessions().sendMessage(session.id, 'Hello!');

// 处理任务
await daemon.processTask({
  name: 'process-data',
  type: 'transform',
  priority: 2,
  payload: { data: [1, 2, 3] },
});

// 停止
await daemon.stop();
```

### 命令行使用

```bash
# 启动守护进程（交互模式）
bun daemon.js start --dir ./my-project

# 后台运行
bun daemon.js start --background --dir ./my-project

# 查看状态
bun daemon.js status --dir ./my-project

# 停止守护进程
bun daemon.js stop --dir ./my-project
```

## 记忆系统

### MemoryStore

三层记忆存储：

```javascript
import { MemoryStore, MEMORY_TYPE } from './src/daemon/memory-store.js';

const memory = new MemoryStore({ dbPath: './memory.db' });
await memory.initialize();

// 语义记忆（概念性知识）
await memory.store(
  'semantic',
  {
    concept: '递归',
    definition: '函数调用自身的过程',
  },
  { tags: ['algorithm', 'basic'] },
);

// 情景记忆（事件序列）
await memory.store(
  'episodic',
  {
    event: '用户反馈',
    details: '需要优化性能',
  },
  { tags: ['feedback', '2024'] },
);

// 程序记忆（技能和流程）
await memory.store(
  'procedural',
  {
    skill: '代码重构',
    steps: ['识别坏味道', '提取方法', '应用设计模式'],
  },
  { tags: ['refactor'] },
);

// 查询记忆
const results = await memory.query('semantic', {
  tags: ['algorithm'],
});
```

### ContextualMemory

支持上下文追踪的记忆系统：

```javascript
import { ContextualMemory } from './src/daemon/memory-store.js';

const memory = new ContextualMemory();

// 添加到上下文
await memory.pushContext('session-123', {
  user: 'input',
  text: '帮我优化这个排序算法',
});

// 获取完整上下文
const context = await memory.getContext('session-123');

// 合并总结
await memory.mergeContext('session-123', {
  summary: '用户需要优化排序算法，可能涉及时间复杂度改进',
});
```

## 会话管理

### SessionManager

```javascript
import { SessionManager, AGENT_MODE } from './src/daemon/session-manager.js';

const sessions = new SessionManager({
  maxConcurrentSessions: 10,
  maxIdleTime: 5 * 60 * 1000,
});

// 创建会话
const session = await sessions.create({
  name: 'coding-agent',
  mode: AGENT_MODE.BACKGROUND,
  metadata: { type: 'assistant' },
});

// 发送消息
await sessions.sendMessage(session.id, '用户输入...', {
  type: 'user',
});

// 获取历史
const history = await sessions.getHistory(session.id, {
  limit: 10,
});

// 更新上下文
await sessions.updateContext(session.id, {
  variables: { current_file: 'src/main.js' },
});

// 暂停/恢复
await sessions.suspend(session.id);
await sessions.resume(session.id);

// 关闭会话
await sessions.close(session.id);
```

## 任务队列

### TaskQueue

```javascript
import { TaskQueue, TASK_PRIORITY } from './src/daemon/task-queue.js';

const queue = new TaskQueue({
  maxConcurrent: 5,
  maxRetries: 3,
});

// 入队（无依赖）
const task1 = await queue.enqueue({
  name: 'task-1',
  type: 'process',
  priority: TASK_PRIORITY.HIGH,
});

// 入队（带依赖）
const task2 = await queue.enqueue({
  name: 'task-2',
  type: 'process',
  dependencies: [task1.id],
});

// 处理任务
await queue.process(task2.id, async (task) => {
  const { data } = task.payload;
  return transform(data);
});

// 事件监听
queue.on('task:complete', (task) => {
  console.log(`✅ ${task.name} 完成`);
});

queue.on('task:failed', (task) => {
  console.error(`❌ ${task.name} 失败:`, task.error);
});
```

## 高级特性

### 自定义心跳处理

```javascript
const daemon = await createDaemon(config);

daemon.on('heartbeat', async (health) => {
  // 自定义心跳处理
  if (health.memory.heapUsed > 500 * 1024 * 1024) {
    await triggerGC();
  }
});

daemon.registerHook('beforeStart', async () => {
  console.log('启动前准备...');
});

daemon.registerHook('afterStart', async () => {
  console.log('启动后初始化...');
});

daemon.registerHook('onRecover', async () => {
  console.log('执行恢复逻辑...');
});
```

### 状态持久化

```javascript
// 守护进程会自动保存状态
// 数据目录结构：
// .daemon/
// ├── state.json          # 运行时状态
// ├── heartbeat.json      # 最新心跳
// ├── daemon.manifest.json # 进程清单
// └── memory.db           # 记忆数据库

// 手动保存
await daemon.saveState();

// 查看状态
const status = daemon.getStatus();
console.log(status.state);
console.log(status.stats.tasksProcessed);
console.log(status.stats.sessionsCreated);
```

### 故障恢复

```javascript
const daemon = await createDaemon({
  dataDir: './.daemon',
  recoveryEnabled: true,
  maxRetries: 3,
  heartbeatInterval: 30000,
});

daemon.on('recover', async (savedState) => {
  console.log('从状态恢复:', savedState);
  // 恢复任务队列
  // 恢复会话
  // 重新建立连接
});
```

## 测试

```bash
# 运行所有测试
bun daemon.js test

# 或直接运行测试脚本
bun src/daemon/test-daemon.js
```

## 文件结构

```
src/daemon/
├── index.js           # 主入口
├── daemon-core.js     # 核心生命周期管理
├── memory-store.js    # 记忆存储系统
├── session-manager.js # 会话管理
├── task-queue.js      # 任务队列
└── test-daemon.js     # 功能测试

daemon.js              # 命令行入口
```

## 性能优化建议

1. **合理设置心跳间隔** - 太短增加负载，太长影响故障检测
2. **内存管理** - 定期清理旧记忆，设置 `maxMemoryAge`
3. **会话超时** - 根据实际需求调整 `maxIdleTime`
4. **并发控制** - 根据系统资源调整 `maxConcurrent`
5. **自动清理** - 启用 `autoCleanup` 定期清理过期数据

## 注意事项

- 确保数据目录有足够的磁盘空间
- 长时间运行时定期监控内存使用
- 多进程环境下注意文件锁问题
- 定期备份重要数据

## 许可证

ISC
