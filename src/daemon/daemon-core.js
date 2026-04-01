/**
 * Daemon Core - 持久守护进程核心
 * 支持后台 agent 会话、记忆整合、进程永生
 */

import { EventEmitter } from 'events';
import { setInterval, clearInterval } from 'timers';
import { pid } from 'process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { promises as fs } from 'fs';
import { MemoryStore } from './memory-store.js';
import { SessionManager } from './session-manager.js';
import { TaskQueue } from './task-queue.js';
import { Logger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const DAEMON_STATE = {
  INIT: 'init',
  RUNNING: 'running',
  PAUSED: 'paused',
  SUSPENDED: 'suspended',
  TERMINATED: 'terminated',
  RECOVERING: 'recovering',
};

export class DaemonCore extends EventEmitter {
  constructor(config = {}) {
    super();
    this.state = DAEMON_STATE.INIT;
    this.pid = pid;
    this.startTime = null;
    this.config = {
      dataDir: config.dataDir || path.join(process.cwd(), '.daemon'),
      heartbeatInterval: config.heartbeatInterval || 30000,
      recoveryEnabled: config.recoveryEnabled !== false,
      maxRetries: config.maxRetries || 3,
      autoSaveInterval: config.autoSaveInterval || 60000,
      ...config,
    };

    this.logger = {
      info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
      debug: (msg, ...args) => {
        if (process.env.DEBUG) console.log(`[DEBUG] ${msg}`, ...args);
      },
      warn: (msg, ...args) => console.warn(`[WARN] ${msg}`, ...args),
      error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
    };

    this.memory = null;
    this.sessions = null;
    this.taskQueue = null;
    this.heartbeatTimer = null;
    this.autoSaveTimer = null;
    this.stats = {
      uptime: 0,
      tasksProcessed: 0,
      sessionsCreated: 0,
      memoryHits: 0,
      memoryMisses: 0,
      lastHeartbeat: null,
      restartCount: 0,
    };

    this.lifecycleHooks = {
      beforeStart: [],
      afterStart: [],
      beforeStop: [],
      afterStop: [],
      onError: [],
      onRecover: [],
    };
  }

  async initialize() {
    try {
      await fs.mkdir(this.config.dataDir, { recursive: true });
      this.memory = new MemoryStore({
        dbPath: path.join(this.config.dataDir, 'memory.db'),
        logger: this.logger,
      });
      await this.memory.initialize();

      this.sessions = new SessionManager({
        store: this.memory,
        logger: this.logger,
      });

      this.taskQueue = new TaskQueue({
        store: this.memory,
        logger: this.logger,
      });

      await this.taskQueue.initialize();
      this.logger.info('Daemon core initialized');
      this.emit('init');
      return this;
    } catch (error) {
      this.logger.error('Failed to initialize daemon', error);
      throw error;
    }
  }

  async start() {
    if (this.state === DAEMON_STATE.RUNNING) {
      this.logger.warn('Daemon is already running');
      return this;
    }

    try {
      await this._runHooks('beforeStart');
      this.state = DAEMON_STATE.RUNNING;
      this.startTime = Date.now();

      if (this.config.recoveryEnabled) {
        await this._recoverState();
      }

      this._startHeartbeat();
      this._startAutoSave();

      const manifest = await this._createManifest();
      await fs.writeFile(
        path.join(this.config.dataDir, 'daemon.manifest.json'),
        JSON.stringify(manifest, null, 2),
      );

      await this._runHooks('afterStart');
      this.logger.info(`Daemon started with PID: ${this.pid}`);
      this.emit('start', manifest);

      return this;
    } catch (error) {
      this.logger.error('Failed to start daemon', error);
      await this._runHooks('onError', error);
      throw error;
    }
  }

  async stop(force = false) {
    try {
      await this._runHooks('beforeStop');
      this.state = DAEMON_STATE.TERMINATED;

      this._stopHeartbeat();
      this._stopAutoSave();

      if (force || this.config.autoSaveInterval) {
        await this.saveState();
      }

      if (this.memory) {
        await this.memory.close();
      }

      await this._runHooks('afterStop');
      this.logger.info('Daemon stopped gracefully');
      this.emit('stop');

      return this;
    } catch (error) {
      this.logger.error('Error during daemon stop', error);
      throw error;
    }
  }

  async pause() {
    if (this.state !== DAEMON_STATE.RUNNING) {
      throw new Error(`Cannot pause from state: ${this.state}`);
    }
    this.state = DAEMON_STATE.PAUSED;
    this._stopHeartbeat();
    this.emit('pause');
    this.logger.info('Daemon paused');
  }

  async resume() {
    if (this.state !== DAEMON_STATE.PAUSED) {
      throw new Error(`Cannot resume from state: ${this.state}`);
    }
    this.state = DAEMON_STATE.RUNNING;
    this._startHeartbeat();
    this.emit('resume');
    this.logger.info('Daemon resumed');
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(async () => {
      try {
        await this._heartbeat();
      } catch (error) {
        this.logger.error('Heartbeat failed', error);
        await this._handleHeartbeatFailure(error);
      }
    }, this.config.heartbeatInterval);

    this.heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async _heartbeat() {
    const now = Date.now();
    this.stats.uptime = now - (this.startTime || now);
    this.stats.lastHeartbeat = now;

    const health = {
      pid: this.pid,
      state: this.state,
      uptime: this.stats.uptime,
      memory: process.memoryUsage(),
      timestamp: now,
    };

    await fs.writeFile(
      path.join(this.config.dataDir, 'heartbeat.json'),
      JSON.stringify(health, null, 2),
    );

    this.emit('heartbeat', health);
    return health;
  }

  async _handleHeartbeatFailure(error) {
    this.logger.warn('Handling heartbeat failure, attempting recovery...');

    if (this.stats.restartCount < this.config.maxRetries) {
      this.stats.restartCount++;
      await this._runHooks('onRecover');
      await this._recoverState();
      this.logger.info(`Recovery attempt ${this.stats.restartCount} completed`);
    } else {
      this.logger.error('Max recovery attempts reached');
      await this.stop(true);
    }
  }

  _startAutoSave() {
    if (this.autoSaveTimer) return;

    this.autoSaveTimer = setInterval(async () => {
      try {
        await this.saveState();
        this.logger.debug('Auto-save completed');
      } catch (error) {
        this.logger.error('Auto-save failed', error);
      }
    }, this.config.autoSaveInterval);

    this.autoSaveTimer.unref();
  }

  _stopAutoSave() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  async saveState() {
    const state = {
      version: '1.0.0',
      pid: this.pid,
      state: this.state,
      startTime: this.startTime,
      stats: this.stats,
      timestamp: Date.now(),
    };

    await fs.writeFile(
      path.join(this.config.dataDir, 'state.json'),
      JSON.stringify(state, null, 2),
    );

    if (this.memory) {
      await this.memory._saveToDisk();
    }
  }

  async _recoverState() {
    try {
      const statePath = path.join(this.config.dataDir, 'state.json');
      const stateExists = await fs
        .access(statePath)
        .then(() => true)
        .catch(() => false);

      if (!stateExists) {
        this.logger.info('No previous state to recover');
        return;
      }

      this.state = DAEMON_STATE.RECOVERING;
      const savedState = JSON.parse(await fs.readFile(statePath, 'utf-8'));

      this.logger.info(`Recovering from state: ${savedState.state}`);
      this.emit('recover', savedState);

      if (savedState.stats) {
        this.stats = {
          ...this.stats,
          ...savedState.stats,
          restartCount: this.stats.restartCount + 1,
        };
      }

      if (this.taskQueue) {
        await this.taskQueue.recoverPending();
      }

      if (this.sessions) {
        await this.sessions.restoreActive();
      }

      this.state = DAEMON_STATE.RUNNING;
      this.logger.info('State recovery completed');
    } catch (error) {
      this.logger.error('Failed to recover state', error);
      this.state = DAEMON_STATE.RUNNING;
    }
  }

  async _createManifest() {
    return {
      version: '1.0.0',
      pid: this.pid,
      state: this.state,
      startTime: this.startTime || Date.now(),
      dataDir: this.config.dataDir,
      heartbeatInterval: this.config.heartbeatInterval,
    };
  }

  registerHook(event, callback) {
    if (this.lifecycleHooks[event]) {
      this.lifecycleHooks[event].push(callback);
    }
  }

  async _runHooks(event, ...args) {
    const hooks = this.lifecycleHooks[event] || [];
    for (const hook of hooks) {
      try {
        await hook(...args);
      } catch (error) {
        this.logger.error(`Hook ${event} failed`, error);
      }
    }
  }

  async createSession(config = {}) {
    const session = await this.sessions.create({
      daemonPid: this.pid,
      ...config,
    });
    this.stats.sessionsCreated++;
    this.emit('session:create', session);
    return session;
  }

  async processTask(task) {
    this.stats.tasksProcessed++;
    this.emit('task:process', task);
    return this.taskQueue.enqueue(task);
  }

  getStatus() {
    return {
      state: this.state,
      pid: this.pid,
      uptime: Date.now() - (this.startTime || Date.now()),
      stats: this.stats,
      memory: process.memoryUsage(),
      timestamp: Date.now(),
    };
  }

  getMemory() {
    return this.memory;
  }

  getSessions() {
    return this.sessions;
  }

  getTaskQueue() {
    return this.taskQueue;
  }
}

export async function createDaemon(config = {}) {
  const daemon = new DaemonCore(config);
  await daemon.initialize();
  return daemon;
}

export function createDaemonSync(config = {}) {
  return new DaemonCore(config);
}
