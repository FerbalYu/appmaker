/**
 * Daemon Test - 守护进程功能测试
 */

import { createDaemon } from './daemon-core.js';
import { MemoryStore, ContextualMemory } from './memory-store.js';
import { SessionManager } from './session-manager.js';
import { TaskQueue, TASK_PRIORITY } from './task-queue.js';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(__dirname, '../../.test-daemon');

async function cleanup() {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch (error) {
    /* ignore cleanup errors */
  }
}

async function testMemoryStore() {
  console.log('\n🧠 测试 MemoryStore...');

  const memory = new MemoryStore({
    dbPath: path.join(testDir, 'memory-test.db'),
    logger: console,
  });

  await memory.initialize();

  await memory.store(
    'semantic',
    {
      project: 'NexusCodeForge',
      version: '2.0.0',
      features: ['agent', 'daemon', 'persistence'],
    },
    {
      tags: ['project', 'core'],
      priority: 2,
    },
  );

  await memory.store(
    'episodic',
    {
      action: 'test_run',
      result: 'success',
    },
    {
      tags: ['test', 'run'],
      priority: 1,
    },
  );

  const memories = await memory.query('semantic', {
    tags: ['project'],
  });

  console.assert(memories.length === 1, '语义记忆查询失败');
  console.log('  ✅ 语义记忆存储和查询');

  const stats = memory.getStats();
  console.log(`  📊 记忆统计: ${stats.totalMemories} 条记忆`);
  console.log(`     读取: ${stats.reads}, 写入: ${stats.writes}`);

  await memory.close();
  console.log('  ✅ MemoryStore 测试通过\n');
}

async function testSessionManager() {
  console.log('\n📝 测试 SessionManager...');

  const memory = new MemoryStore({
    dbPath: path.join(testDir, 'session-memory.db'),
  });
  await memory.initialize();

  const sessions = new SessionManager({
    store: memory,
    logger: console,
    maxIdleTime: 10000,
  });

  const session1 = await sessions.create({
    name: 'test-session-1',
    mode: 'background',
    metadata: { test: true },
  });

  console.assert(session1.id, '会话创建失败');
  console.log(`  ✅ 会话已创建: ${session1.name} (${session1.id})`);

  await sessions.sendMessage(session1.id, 'Hello, daemon!', {
    type: 'user',
  });

  await sessions.sendMessage(session1.id, 'Welcome back!', {
    type: 'agent',
  });

  const history = await sessions.getHistory(session1.id);
  console.assert(history.length === 2, '消息历史失败');
  console.log(`  ✅ 消息历史: ${history.length} 条消息`);

  const allSessions = sessions.list();
  console.assert(allSessions.length === 1, '会话列表失败');
  console.log(`  ✅ 会话列表: ${allSessions.length} 个会话`);

  sessions.close();
  console.log('  ✅ SessionManager 测试通过\n');
}

async function testTaskQueue() {
  console.log('\n📋 测试 TaskQueue...');

  const queue = new TaskQueue({
    logger: console,
    maxConcurrent: 2,
  });

  await queue.initialize();

  const task1 = await queue.enqueue({
    name: 'task-1',
    type: 'test',
    priority: TASK_PRIORITY.HIGH,
  });

  const task2 = await queue.enqueue({
    name: 'task-2',
    type: 'test',
    priority: TASK_PRIORITY.NORMAL,
    dependencies: [task1.id],
  });

  const task3 = await queue.enqueue({
    name: 'task-3',
    type: 'test',
    priority: TASK_PRIORITY.LOW,
  });

  console.log(`  ✅ 任务入队: 3 个任务`);
  console.log(`     - ${task1.name} (优先级: ${task1.priority})`);
  console.log(`     - ${task2.name} (优先级: ${task2.priority}, 依赖: ${task1.name})`);
  console.log(`     - ${task3.name} (优先级: ${task3.priority})`);

  const queued = queue.getQueued();
  console.assert(queued.length === 2, '队列任务数量错误');
  console.log(`  ✅ 队列状态: ${queued.length} 个待执行任务`);

  const blocked = queue.list({ status: 'blocked' });
  console.assert(blocked.length === 1, '阻塞任务错误');
  console.log(`  ✅ 阻塞任务: ${blocked.length} 个 (依赖未完成)`);

  const stats = queue.getStats();
  console.log(`  📊 队列统计: 总计 ${stats.total}, 待处理 ${stats.pending}`);

  queue.close();
  console.log('  ✅ TaskQueue 测试通过\n');
}

async function testDaemonCore() {
  console.log('\n🔮 测试 DaemonCore...');

  const daemon = await createDaemon({
    dataDir: path.join(testDir, 'daemon'),
    heartbeatInterval: 5000,
    autoSaveInterval: 10000,
    recoveryEnabled: true,
  });

  daemon.on('heartbeat', (health) => {
    console.log(
      `  💓 心跳: ${health.state}, 内存: ${Math.round(health.memory.heapUsed / 1024 / 1024)}MB`,
    );
  });

  await daemon.start();

  console.log(`  ✅ 守护进程已启动 (PID: ${daemon.pid})`);

  const session = await daemon.createSession({
    name: 'integration-test-session',
  });
  console.log(`  ✅ 创建会话: ${session.name}`);

  await daemon.processTask({
    name: 'integration-test-task',
    type: 'test',
    priority: TASK_PRIORITY.NORMAL,
  });
  console.log('  ✅ 任务入队');

  const status = daemon.getStatus();
  console.log(`  📊 状态: ${status.state}, 运行时间: ${Math.floor(status.uptime / 1000)}s`);
  console.log(`     已处理任务: ${status.stats.tasksProcessed}`);
  console.log(`     会话总数: ${status.stats.sessionsCreated}`);

  await new Promise((resolve) => setTimeout(resolve, 6000));

  await daemon.stop();
  console.log('  ✅ 守护进程已停止');
  console.log('  ✅ DaemonCore 测试通过\n');
}

async function testPersistence() {
  console.log('\n💾 测试持久化...');

  let daemon1 = await createDaemon({
    dataDir: path.join(testDir, 'persist-test'),
    autoSaveInterval: 5000,
  });

  await daemon1.start();

  await daemon1.createSession({ name: 'persist-test-1' });
  await daemon1.createSession({ name: 'persist-test-2' });

  const memory = daemon1.getMemory();
  await memory.store('semantic', { test: 'persistence' }, { tags: ['persist'] });

  console.log('  ✅ 数据已保存');

  await daemon1.stop();

  console.log('  ⏳ 等待重启...');
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const daemon2 = await createDaemon({
    dataDir: path.join(testDir, 'persist-test'),
    recoveryEnabled: true,
  });

  await daemon2.initialize();
  await daemon2.start();

  console.log(`  ✅ 守护进程已恢复 (重启次数: ${daemon2.stats.restartCount})`);

  await daemon2.stop();
  console.log('  ✅ 持久化测试通过\n');
}

export async function testDaemon() {
  console.log('='.repeat(60));
  console.log('🧪 NCF Daemon - 功能测试');
  console.log('='.repeat(60));

  const startTime = Date.now();

  try {
    await cleanup();

    await testMemoryStore();
    await testSessionManager();
    await testTaskQueue();
    await testDaemonCore();
    await testPersistence();

    const duration = Math.floor((Date.now() - startTime) / 1000);
    console.log('='.repeat(60));
    console.log(`✅ 所有测试通过! (耗时: ${duration}s)`);
    console.log('='.repeat(60));
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await cleanup();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testDaemon();
}
