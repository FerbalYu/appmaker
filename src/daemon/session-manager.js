/**
 * Session Manager - 后台 Agent 会话管理
 * 管理多个并发的 agent 会话，支持上下文保持和状态恢复
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { setTimeout, clearTimeout } from 'timers';

export const SESSION_STATE = {
  ACTIVE: 'active',
  IDLE: 'idle',
  SUSPENDED: 'suspended',
  TERMINATED: 'terminated',
  WAITING: 'waiting'
};

export const AGENT_MODE = {
  FOREGROUND: 'foreground',
  BACKGROUND: 'background',
  DAEMON: 'daemon'
};

export class SessionManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      store: config.store,
      logger: config.logger,
      sessionTimeout: config.sessionTimeout || 30 * 60 * 1000,
      maxIdleTime: config.maxIdleTime || 5 * 60 * 1000,
      maxConcurrentSessions: config.maxConcurrentSessions || 10,
      autoCleanup: config.autoCleanup !== false,
      ...config
    };

    this.sessions = new Map();
    this.activeAgents = new Map();
    this.sessionTimers = new Map();

    this.logger = this.config.logger || {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {}
    };

    this.stats = {
      totalCreated: 0,
      totalClosed: 0,
      totalMessages: 0,
      activeCount: 0
    };

    if (this.config.autoCleanup) {
      this._startCleanupTimer();
    }
  }

  async create(config = {}) {
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw new Error(`Maximum concurrent sessions reached: ${this.config.maxConcurrentSessions}`);
    }

    const sessionId = config.id || this._generateSessionId();
    const now = Date.now();

    const session = {
      id: sessionId,
      name: config.name || `session-${sessionId.substring(0, 8)}`,
      mode: config.mode || AGENT_MODE.BACKGROUND,
      state: SESSION_STATE.ACTIVE,
      daemonPid: config.daemonPid,

      context: {
        workingDir: config.workingDir || process.cwd(),
        projectPath: config.projectPath,
        env: { ...process.env },
        history: [],
        variables: {},
        metadata: config.metadata || {}
      },

      agent: {
        type: config.agentType || 'generic',
        config: config.agentConfig || {},
        state: null
      },

      timing: {
        created: now,
        lastActivity: now,
        lastMessage: now,
        totalDuration: 0,
        idleTime: 0
      },

      stats: {
        messageCount: 0,
        taskCount: 0,
        errorCount: 0
      },

      settings: {
        autoSave: config.autoSave !== false,
        persistent: config.persistent !== false,
        priority: config.priority || 1
      }
    };

    this.sessions.set(sessionId, session);
    this.stats.totalCreated++;
    this.stats.activeCount = this.sessions.size;

    if (config.initialContext) {
      await this.updateContext(sessionId, config.initialContext);
    }

    this._startSessionTimer(sessionId);
    this.logger.info(`Session created: ${sessionId} (${session.name})`);
    this.emit('session:create', session);

    return session;
  }

  async sendMessage(sessionId, message, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const now = Date.now();
    const msg = {
      id: this._generateMessageId(),
      type: options.type || 'user',
      content: message,
      timestamp: now,
      metadata: options.metadata || {}
    };

    session.context.history.push(msg);
    session.timing.lastMessage = now;
    session.timing.lastActivity = now;
    session.stats.messageCount++;
    this.stats.totalMessages++;

    if (options.context) {
      session.context.variables = {
        ...session.context.variables,
        ...options.context
      };
    }

    this._resetSessionTimer(sessionId);
    this.emit('message', { sessionId, message: msg });

    return msg;
  }

  async getHistory(sessionId, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    let history = [...session.context.history];

    if (options.since) {
      history = history.filter(m => m.timestamp >= options.since);
    }

    if (options.until) {
      history = history.filter(m => m.timestamp <= options.until);
    }

    if (options.type) {
      history = history.filter(m => m.type === options.type);
    }

    if (options.limit) {
      history = history.slice(-options.limit);
    }

    return history;
  }

  async updateContext(sessionId, updates) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.context = {
      ...session.context,
      ...updates,
      variables: {
        ...session.context.variables,
        ...(updates.variables || {})
      }
    };

    session.timing.lastActivity = Date.now();
    this.emit('context:update', { sessionId, context: session.context });

    return session.context;
  }

  async getContext(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session.context;
  }

  async suspend(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const wasActive = session.state === SESSION_STATE.ACTIVE;
    session.state = SESSION_STATE.SUSPENDED;
    session.timing.totalDuration += Date.now() - session.timing.created;
    this._cancelSessionTimer(sessionId);

    if (wasActive) {
      this.emit('session:suspend', session);
    }

    return session;
  }

  async resume(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.state !== SESSION_STATE.SUSPENDED && session.state !== SESSION_STATE.IDLE) {
      throw new Error(`Cannot resume session from state: ${session.state}`);
    }

    session.state = SESSION_STATE.ACTIVE;
    session.timing.created = Date.now();
    session.timing.idleTime = 0;
    this._startSessionTimer(sessionId);

    this.emit('session:resume', session);
    return session;
  }

  async close(sessionId, reason = 'normal') {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new error(`Session not found: ${sessionId}`);
    }

    session.state = SESSION_STATE.TERMINATED;
    session.timing.totalDuration = Date.now() - session.timing.created;
    this._cancelSessionTimer(sessionId);

    this.sessions.delete(sessionId);
    this.stats.totalClosed++;
    this.stats.activeCount = this.sessions.size;

    if (this.config.store && session.settings.persistent) {
      await this.config.store.store('procedural', {
        sessionId,
        summary: await this._generateSessionSummary(session),
        duration: session.timing.totalDuration,
        stats: session.stats
      }, {
        tags: ['session', 'closed', reason],
        priority: 1
      });
    }

    this.logger.info(`Session closed: ${sessionId} (${reason})`);
    this.emit('session:close', { sessionId, reason, summary: session });

    return session;
  }

  async _generateSessionSummary(session) {
    return {
      id: session.id,
      name: session.name,
      mode: session.mode,
      duration: session.timing.totalDuration,
      messageCount: session.stats.messageCount,
      taskCount: session.stats.taskCount,
      errorCount: session.stats.errorCount,
      lastVariables: session.context.variables,
      tags: session.context.metadata.tags || []
    };
  }

  get(sessionId) {
    return this.sessions.get(sessionId);
  }

  list(options = {}) {
    let sessions = Array.from(this.sessions.values());

    if (options.state) {
      sessions = sessions.filter(s => s.state === options.state);
    }

    if (options.mode) {
      sessions = sessions.filter(s => s.mode === options.mode);
    }

    if (options.minPriority !== undefined) {
      sessions = sessions.filter(s => s.settings.priority >= options.minPriority);
    }

    if (options.sortBy) {
      const sortKey = options.sortBy;
      sessions.sort((a, b) => {
        if (sortKey === 'lastActivity') {
          return b.timing.lastActivity - a.timing.lastActivity;
        }
        if (sortKey === 'created') {
          return b.timing.created - a.timing.created;
        }
        if (sortKey === 'priority') {
          return b.settings.priority - a.settings.priority;
        }
        return 0;
      });
    }

    if (options.limit) {
      sessions = sessions.slice(0, options.limit);
    }

    return sessions;
  }

  _startSessionTimer(sessionId) {
    if (this.sessionTimers.has(sessionId)) {
      clearTimeout(this.sessionTimers.get(sessionId));
    }

    const timer = setTimeout(() => {
      this._handleSessionTimeout(sessionId);
    }, this.config.maxIdleTime);

    timer.unref();
    this.sessionTimers.set(sessionId, timer);
  }

  _resetSessionTimer(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.state === SESSION_STATE.IDLE) {
      session.state = SESSION_STATE.ACTIVE;
    }
    this._startSessionTimer(sessionId);
  }

  _cancelSessionTimer(sessionId) {
    if (this.sessionTimers.has(sessionId)) {
      clearTimeout(this.sessionTimers.get(sessionId));
      this.sessionTimers.delete(sessionId);
    }
  }

  async _handleSessionTimeout(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === SESSION_STATE.TERMINATED) {
      return;
    }

    const idleTime = Date.now() - session.timing.lastActivity;

    if (idleTime >= this.config.maxIdleTime) {
      if (session.settings.persistent) {
        session.state = SESSION_STATE.IDLE;
        this.emit('session:idle', session);
        this.logger.info(`Session idle: ${sessionId}`);
      } else {
        await this.close(sessionId, 'timeout');
      }
    }
  }

  _startCleanupTimer() {
    this.cleanupTimer = setInterval(async () => {
      const idleSessions = this.list({ state: SESSION_STATE.IDLE });
      let cleaned = 0;

      for (const session of idleSessions) {
        const idleTime = Date.now() - session.timing.lastActivity;
        if (idleTime > this.config.sessionTimeout) {
          await this.close(session.id, 'cleanup');
          cleaned++;
        }
      }

      if (cleaned > 0 && typeof global.gc === 'function') {
        try {
          global.gc();
          this.logger.debug(`Cleaned up ${cleaned} sessions and executed GC.`);
        } catch (e) {}
      }
    }, this.config.sessionTimeout / 2);

    this.cleanupTimer.unref();
  }

  async restoreActive() {
    this.logger.info('Restoring active sessions from persistent storage');
  }

  getStats() {
    return {
      ...this.stats,
      sessions: this.sessions.size,
      byState: {
        active: this.list({ state: SESSION_STATE.ACTIVE }).length,
        idle: this.list({ state: SESSION_STATE.IDLE }).length,
        suspended: this.list({ state: SESSION_STATE.SUSPENDED }).length
      }
    };
  }

  _generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  _generateMessageId() {
    return crypto.randomBytes(8).toString('hex');
  }

  close() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    for (const timer of this.sessionTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionTimers.clear();

    this.logger.info('Session manager closed');
  }
}

export class BackgroundAgent {
  constructor(session, config = {}) {
    this.session = session;
    this.config = {
      pollingInterval: config.pollingInterval || 5000,
      maxRetries: config.maxRetries || 3,
      ...config
    };

    this.state = 'init';
    this.running = false;
    this.handlers = new Map();
    this.interval = null;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
    return this;
  }

  async start() {
    if (this.running) return;

    this.running = true;
    this.state = 'running';

    this.interval = setInterval(async () => {
      try {
        await this._poll();
      } catch (error) {
        this.state = 'error';
        this.handlers.get('error')?.(error);
      }
    }, this.config.pollingInterval);

    this.interval.unref();
    this.handlers.get('start')?.();
  }

  async stop() {
    this.running = false;
    this.state = 'stopped';

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    this.handlers.get('stop')?.();
  }

  async _poll() {
    this.handlers.get('poll')?.();
  }
}
