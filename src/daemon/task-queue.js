/**
 * Task Queue - 任务队列管理
 * 支持优先级、依赖、状态追踪的任务队列
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { setTimeout, clearTimeout } from 'timers';

export const TASK_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  BLOCKED: 'blocked'
};

export const TASK_PRIORITY = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  CRITICAL: 3,
  URGENT: 4
};

export class Task {
  constructor(config) {
    this.id = config.id || this._generateId();
    this.type = config.type || 'generic';
    this.name = config.name || `task-${this.id.substring(0, 8)}`;

    this.status = TASK_STATUS.PENDING;
    this.priority = config.priority || TASK_PRIORITY.NORMAL;

    this.payload = config.payload || {};
    this.result = null;
    this.error = null;

    this.dependencies = config.dependencies || [];
    this.dependents = new Set();

    this.timing = {
      created: Date.now(),
      queued: null,
      started: null,
      completed: null,
      duration: 0
    };

    this.retry = {
      count: 0,
      maxRetries: config.maxRetries || 3,
      backoff: config.backoff || 1000
    };

    this.metadata = config.metadata || {};
    this.tags = config.tags || [];

    this.sessionId = config.sessionId;
    this.progress = {
      current: 0,
      total: 100,
      message: ''
    };
  }

  _generateId() {
    return crypto.randomBytes(16).toString('hex');
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      name: this.name,
      status: this.status,
      priority: this.priority,
      payload: this.payload,
      result: this.result,
      error: this.error,
      dependencies: Array.from(this.dependencies),
      timing: this.timing,
      retry: this.retry,
      metadata: this.metadata,
      tags: this.tags,
      sessionId: this.sessionId,
      progress: this.progress
    };
  }
}

export class TaskQueue extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      store: config.store,
      logger: config.logger,
      maxConcurrent: config.maxConcurrent || 5,
      maxQueueSize: config.maxQueueSize || 1000,
      defaultTimeout: config.defaultTimeout || 5 * 60 * 1000,
      autoCleanup: config.autoCleanup !== false,
      cleanupInterval: config.cleanupInterval || 60 * 60 * 1000,
      ...config
    };

    this.tasks = new Map();
    this.queues = {
      [TASK_PRIORITY.URGENT]: [],
      [TASK_PRIORITY.CRITICAL]: [],
      [TASK_PRIORITY.HIGH]: [],
      [TASK_PRIORITY.NORMAL]: [],
      [TASK_PRIORITY.LOW]: []
    };

    this.running = new Map();
    this.blocked = new Map();

    this.processors = new Map();
    this.activeCount = 0;

    this.logger = this.config.logger || {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {}
    };

    if (this.logger && !this.logger.debug) {
      this.logger.debug = () => {};
    }

    this.stats = {
      enqueued: 0,
      processed: 0,
      failed: 0,
      cancelled: 0,
      retries: 0
    };

    if (this.config.autoCleanup) {
      this._startCleanupTimer();
    }
  }

  async initialize() {
    this.logger.info('Task queue initialized');
  }

  async enqueue(config) {
    if (this.tasks.size >= this.config.maxQueueSize) {
      throw new Error(`Queue is full: ${this.tasks.size}/${this.config.maxQueueSize}`);
    }

    const task = config instanceof Task ? config : new Task(config);
    this.tasks.set(task.id, task);

    for (const depId of task.dependencies) {
      const depTask = this.tasks.get(depId);
      if (depTask) {
        depTask.dependents.add(task.id);
      }
    }

    if (this._canExecute(task)) {
      task.status = TASK_STATUS.QUEUED;
      task.timing.queued = Date.now();
      this._addToPriorityQueue(task);
      this._emit('task:queued', task);
    } else {
      task.status = TASK_STATUS.BLOCKED;
      this.blocked.set(task.id, task);
      this._emit('task:blocked', task);
    }

    this.stats.enqueued++;
    this.logger.debug(`Task enqueued: ${task.id} (${task.name})`);
    this._emit('task:enqueue', task);

    this._processNext();

    return task;
  }

  async process(taskId, handler) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== TASK_STATUS.QUEUED && task.status !== TASK_STATUS.PENDING) {
      throw new Error(`Task is not in a processable state: ${task.status}`);
    }

    this.processors.set(taskId, handler);
    return this._executeTask(task);
  }

  async _executeTask(task) {
    if (this.activeCount >= this.config.maxConcurrent) {
      return false;
    }

    const handler = this.processors.get(task.id);
    if (!handler) {
      this.logger.warn(`No handler for task: ${task.id}`);
      return false;
    }

    task.status = TASK_STATUS.RUNNING;
    task.timing.started = Date.now();
    this.activeCount++;
    this.running.set(task.id, task);
    this._removeFromPriorityQueue(task);

    this._emit('task:start', task);
    this.logger.info(`Task started: ${task.id} (${task.name})`);

    try {
      // 取消任务队列层的硬性总时间超时限制，依靠具体的工具/API调用超时
      const result = await handler(task, this);

      task.status = TASK_STATUS.COMPLETED;
      task.result = result;
      task.timing.completed = Date.now();
      task.timing.duration = task.timing.completed - task.timing.started;

      this.stats.processed++;
      this._emit('task:complete', task);
      this.logger.info(`Task completed: ${task.id} in ${task.timing.duration}ms`);

    } catch (error) {
      task.error = {
        message: error.message,
        stack: error.stack,
        timestamp: Date.now()
      };

      if (task.retry.count < task.retry.maxRetries) {
        task.retry.count++;
        this.stats.retries++;
        await this._retryTask(task);
      } else {
        task.status = TASK_STATUS.FAILED;
        this.stats.failed++;
        this._emit('task:failed', task);
        this.logger.error(`Task failed: ${task.id}`, error);
      }
    } finally {
      this.activeCount--;
      this.running.delete(task.id);
      this.processors.delete(task.id);
      this._unblockDependents(task.id);
      this._processNext();
    }

    return task;
  }

  async _retryTask(task) {
    const backoffTime = task.retry.backoff * Math.pow(2, task.retry.count - 1);

    this.logger.info(`Retrying task ${task.id} in ${backoffTime}ms (attempt ${task.retry.count}/${task.retry.maxRetries})`);

    await new Promise(resolve => {
      const timer = setTimeout(resolve, backoffTime);
      timer.unref();
    });

    task.status = TASK_STATUS.QUEUED;
    task.timing.queued = Date.now();
    this._addToPriorityQueue(task);
    this._emit('task:retry', task);
  }

  cancel(taskId, reason = 'cancelled') {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    if (task.status === TASK_STATUS.RUNNING) {
      this.logger.warn(`Cannot cancel running task: ${taskId}`);
      return false;
    }

    task.status = TASK_STATUS.CANCELLED;
    task.error = { reason, timestamp: Date.now() };
    this._removeFromPriorityQueue(task);
    this.blocked.delete(taskId);

    this.stats.cancelled++;
    this._emit('task:cancel', task);
    this.logger.info(`Task cancelled: ${taskId} (${reason})`);

    this._unblockDependents(taskId);
    this._processNext();

    return true;
  }

  get(taskId) {
    return this.tasks.get(taskId);
  }

  list(options = {}) {
    let tasks = Array.from(this.tasks.values());

    if (options.status) {
      tasks = tasks.filter(t => t.status === options.status);
    }

    if (options.priority !== undefined) {
      tasks = tasks.filter(t => t.priority === options.priority);
    }

    if (options.type) {
      tasks = tasks.filter(t => t.type === options.type);
    }

    if (options.sessionId) {
      tasks = tasks.filter(t => t.sessionId === options.sessionId);
    }

    if (options.since) {
      tasks = tasks.filter(t => t.timing.created >= options.since);
    }

    if (options.sortBy) {
      tasks.sort((a, b) => {
        if (options.sortBy === 'priority') {
          return b.priority - a.priority;
        }
        if (options.sortBy === 'created') {
          return b.timing.created - a.timing.created;
        }
        if (options.sortBy === 'started') {
          return (b.timing.started || 0) - (a.timing.started || 0);
        }
        return 0;
      });
    }

    if (options.limit) {
      tasks = tasks.slice(0, options.limit);
    }

    return tasks;
  }

  getPending() {
    return this.list({ status: TASK_STATUS.PENDING });
  }

  getQueued() {
    return this.list({ status: TASK_STATUS.QUEUED });
  }

  getRunning() {
    return this.list({ status: TASK_STATUS.RUNNING });
  }

  getCompleted() {
    return this.list({ status: TASK_STATUS.COMPLETED });
  }

  getFailed() {
    return this.list({ status: TASK_STATUS.FAILED });
  }

  async clear(options = {}) {
    const toClear = this.list(options);
    let count = 0;

    for (const task of toClear) {
      if (task.status !== TASK_STATUS.RUNNING) {
        this.tasks.delete(task.id);
        this._removeFromPriorityQueue(task);
        this.blocked.delete(task.id);
        count++;
      }
    }

    this.logger.info(`Cleared ${count} tasks`);
    return count;
  }

  async recoverPending() {
    const pending = this.getPending().concat(this.getQueued());

    for (const task of pending) {
      if (this._canExecute(task)) {
        task.status = TASK_STATUS.QUEUED;
        task.timing.queued = Date.now();
        this._addToPriorityQueue(task);
      } else {
        task.status = TASK_STATUS.BLOCKED;
        this.blocked.set(task.id, task);
      }
    }

    this.logger.info(`Recovered ${pending.length} pending tasks`);
  }

  _canExecute(task) {
    if (task.dependencies.length === 0) {
      return true;
    }

    return task.dependencies.every(depId => {
      const depTask = this.tasks.get(depId);
      return depTask && depTask.status === TASK_STATUS.COMPLETED;
    });
  }

  _unblockDependents(taskId) {
    for (const [depId, dependent] of this.blocked) {
      if (dependent.dependencies.includes(taskId)) {
        if (this._canExecute(dependent)) {
          dependent.status = TASK_STATUS.QUEUED;
          dependent.timing.queued = Date.now();
          this.blocked.delete(depId);
          this._addToPriorityQueue(dependent);
          this._emit('task:unblocked', dependent);
        }
      }
    }
  }

  _processNext() {
    while (this.activeCount < this.config.maxConcurrent) {
      const task = this._getNextTask();
      if (!task) break;

      this._executeTask(task).catch(error => {
        this.logger.error(`Task execution error: ${task.id}`, error);
      });
    }
  }

  _getNextTask() {
    for (const priority of Object.values(TASK_PRIORITY).reverse()) {
      const queue = this.queues[priority];
      if (queue.length > 0) {
        return queue.shift();
      }
    }
    return null;
  }

  _addToPriorityQueue(task) {
    const queue = this.queues[task.priority];
    if (queue && !queue.includes(task)) {
      queue.push(task);
    }
  }

  _removeFromPriorityQueue(task) {
    const queue = this.queues[task.priority];
    if (queue) {
      const index = queue.indexOf(task);
      if (index !== -1) {
        queue.splice(index, 1);
      }
    }
  }

  _startCleanupTimer() {
    this.cleanupTimer = setInterval(async () => {
      const oldTasks = this.list({
        status: TASK_STATUS.COMPLETED,
        since: Date.now() - 24 * 60 * 60 * 1000
      });

      for (const task of oldTasks) {
        this.tasks.delete(task.id);
      }

      if (oldTasks.length > 0) {
        this.logger.debug(`Cleaned up ${oldTasks.length} old tasks`);
      }
    }, this.config.cleanupInterval);

    this.cleanupTimer.unref();
  }

  _emit(event, task) {
    this.emit(event, task);
  }

  getStats() {
    return {
      ...this.stats,
      total: this.tasks.size,
      active: this.activeCount,
      pending: this.getPending().length,
      queued: this.getQueued().length,
      running: this.getRunning().length,
      completed: this.getCompleted().length,
      failed: this.getFailed().length,
      byPriority: Object.fromEntries(
        Object.entries(this.queues).map(([p, q]) => [p, q.length])
      )
    };
  }

  close() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    for (const task of this.running.values()) {
      task.status = TASK_STATUS.CANCELLED;
    }

    this.logger.info('Task queue closed');
  }
}
