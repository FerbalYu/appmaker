/**
 * Daemon System - 主入口
 * 持久守护进程主入口文件
 */

export { DaemonCore, DAEMON_STATE, createDaemon, createDaemonSync } from './daemon-core.js';
export { MemoryStore, ContextualMemory, MEMORY_TYPE, PRIORITY } from './memory-store.js';
export { SessionManager, SESSION_STATE, AGENT_MODE, BackgroundAgent } from './session-manager.js';
export { TaskQueue, Task, TASK_STATUS, TASK_PRIORITY } from './task-queue.js';

import { createDaemon, DaemonCore } from './daemon-core.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class PersistentDaemon {
  constructor(config = {}) {
    this.config = {
      workingDir: config.workingDir || process.cwd(),
      dataDir: config.dataDir || path.join(process.cwd(), '.daemon'),
      logLevel: config.logLevel || 'info',
      ...config,
    };

    this.daemon = null;
    this.isRunning = false;
    this.isInteractive = config.interactive !== false;
  }

  async start(options = {}) {
    try {
      console.log('='.repeat(60));
      console.log('🔮 Persistent Daemon - 持久守护进程');
      console.log('工作目录:', this.config.workingDir);
      console.log('数据目录:', this.config.dataDir);
      console.log('='.repeat(60));
      console.log();

      this.daemon = await createDaemon({
        dataDir: this.config.dataDir,
        logLevel: this.config.logLevel,
        heartbeatInterval: options.heartbeatInterval || 30000,
        autoSaveInterval: options.autoSaveInterval || 60000,
        recoveryEnabled: options.recoveryEnabled !== false,
        maxRetries: options.maxRetries || 3,
      });

      this.daemon.on('start', (manifest) => {
        console.log('✅ 守护进程已启动');
        console.log('PID:', manifest.pid);
        console.log('数据目录:', manifest.dataDir);
      });

      this.daemon.on('heartbeat', (health) => {
        console.log(`💓 心跳 [${new Date().toLocaleTimeString()}]`, {
          state: health.state,
          uptime: Math.floor(health.uptime / 1000) + 's',
          memory: Math.round(health.memory.heapUsed / 1024 / 1024) + 'MB',
        });
      });

      this.daemon.on('session:create', (session) => {
        console.log('📝 会话已创建:', session.name);
      });

      this.daemon.on('task:enqueue', (task) => {
        console.log('📋 任务入队:', task.name, `(${task.priority})`);
      });

      this.daemon.on('error', (error) => {
        console.error('❌ 错误:', error.message);
      });

      await this.daemon.start();

      if (this.isInteractive) {
        await this._startInteractive();
      }

      this.isRunning = true;
      return this.daemon;
    } catch (error) {
      console.error('❌ 启动失败:', error.message);
      throw error;
    }
  }

  async stop() {
    if (this.daemon) {
      await this.daemon.stop();
      console.log('👋 守护进程已停止');
      this.isRunning = false;
    }
  }

  async _startInteractive() {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      rl.question('\ndaemon> ', async (input) => {
        const command = input.trim().toLowerCase();
        const args = input.trim().split(/\s+/);

        try {
          await this._handleCommand(args[0], args.slice(1));
        } catch (error) {
          console.error('命令执行失败:', error.message);
        }

        if (this.isRunning) {
          prompt();
        }
      });
    };

    console.log('\n📌 交互命令:');
    console.log('  status   - 查看守护进程状态');
    console.log('  sessions - 列出所有会话');
    console.log('  tasks    - 查看任务队列');
    console.log('  memory   - 查看记忆统计');
    console.log('  create   - 创建新会话');
    console.log('  stop     - 停止守护进程');
    console.log('  exit     - 退出交互模式');
    console.log();

    prompt();
  }

  async _handleCommand(command, args) {
    switch (command) {
      case 'status': {
        const status = this.daemon.getStatus();
        console.log('\n📊 守护进程状态:');
        console.log('  状态:', status.state);
        console.log('  PID:', status.pid);
        console.log('  运行时间:', Math.floor(status.uptime / 1000) + 's');
        console.log('  已处理任务:', status.stats.tasksProcessed);
        console.log('  会话总数:', status.stats.sessionsCreated);
        console.log();
        break;
      }

      case 'sessions': {
        const sessions = this.daemon.getSessions().list();
        console.log('\n📝 会话列表:', sessions.length);
        for (const s of sessions) {
          console.log(`  - ${s.name} [${s.state}]`);
        }
        console.log();
        break;
      }

      case 'tasks': {
        const queue = this.daemon.getTaskQueue();
        const taskStats = queue.getStats();
        console.log('\n📋 任务队列:');
        console.log('  总计:', taskStats.total);
        console.log('  运行中:', taskStats.active);
        console.log('  待处理:', taskStats.pending);
        console.log('  已完成:', taskStats.completed);
        console.log('  失败:', taskStats.failed);
        console.log();
        break;
      }

      case 'memory': {
        const memory = this.daemon.getMemory();
        const memStats = memory.getStats();
        console.log('\n🧠 记忆统计:');
        console.log('  总记忆数:', memStats.totalMemories);
        console.log('  读取次数:', memStats.reads);
        console.log('  写入次数:', memStats.writes);
        console.log('  命中:', memStats.hits);
        console.log('  未命中:', memStats.misses);
        console.log();
        break;
      }

      case 'create': {
        const newSession = await this.daemon.createSession({
          name: args.join(' ') || `session-${Date.now()}`,
        });
        console.log('✅ 会话已创建:', newSession.id);
        break;
      }

      case 'stop':
        await this.stop();
        process.exit(0);
        break;

      case 'exit':
        console.log('退出交互模式，守护进程继续在后台运行');
        break;

      default:
        console.log('未知命令:', command);
    }
  }

  getDaemon() {
    return this.daemon;
  }
}

export async function runDaemon(options = {}) {
  const daemon = new PersistentDaemon(options);
  await daemon.start(options);
  return daemon;
}

export default PersistentDaemon;
