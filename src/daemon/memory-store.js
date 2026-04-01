/**
 * Memory Store - 记忆存储系统
 * 实现语义记忆、操作记忆、情境记忆的持久化存储
 */

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

export const MEMORY_TYPE = {
  EPISODIC: 'episodic',
  SEMANTIC: 'semantic',
  PROCEDURAL: 'procedural',
  WORKING: 'working',
};

export const PRIORITY = {
  LOW: 0,
  NORMAL: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export class MemoryStore {
  constructor(config = {}) {
    this.config = {
      dbPath: config.dbPath || './.daemon/memory.db',
      maxMemoryAge: config.maxMemoryAge || 7 * 24 * 60 * 60 * 1000,
      autoCleanup: config.autoCleanup !== false,
      logger: config.logger,
    };

    this.db = {
      semantic: new Map(),
      episodic: new Map(),
      procedural: new Map(),
      working: new Map(),
    };

    this.indexes = {
      byType: new Map(),
      byPriority: new Map(),
      byTimestamp: new Map(),
      byTag: new Map(),
    };

    this.logger = this.config.logger || {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
    };

    this.stats = {
      reads: 0,
      writes: 0,
      hits: 0,
      misses: 0,
      cleanupCount: 0,
    };
  }

  async initialize() {
    try {
      await fs.mkdir(path.dirname(this.config.dbPath), { recursive: true });
      await this._loadFromDisk();
      if (this.config.autoCleanup) {
        await this.cleanup();
      }
      this.logger.info('Memory store initialized');
    } catch (error) {
      this.logger.error('Failed to initialize memory store', error);
      throw error;
    }
  }

  async _loadFromDisk() {
    try {
      const data = await fs.readFile(this.config.dbPath, 'utf-8');
      const parsed = JSON.parse(data);

      for (const [type, memories] of Object.entries(parsed)) {
        if (this.db[type]) {
          this.db[type] = new Map(memories);
        }
      }

      this._rebuildIndexes();
      this.logger.info('Memory data loaded from disk');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('Failed to load memory from disk', error);
      }
    }
  }

  async _saveToDisk() {
    try {
      const data = {};
      for (const [type, memories] of Object.entries(this.db)) {
        data[type] = Array.from(memories.entries());
      }
      await fs.writeFile(this.config.dbPath, JSON.stringify(data, null, 2));
    } catch (error) {
      this.logger.error('Failed to save memory to disk', error);
      throw error;
    }
  }

  _rebuildIndexes() {
    this.indexes = {
      byType: new Map(),
      byPriority: new Map(),
      byTimestamp: new Map(),
      byTag: new Map(),
    };

    for (const [type, memories] of Object.entries(this.db)) {
      this.indexes.byType.set(type, new Set(memories.keys()));

      for (const [id, memory] of memories) {
        if (!this.indexes.byPriority.has(memory.priority)) {
          this.indexes.byPriority.set(memory.priority, new Set());
        }
        this.indexes.byPriority.get(memory.priority).add(id);

        const timestamp = Math.floor((memory.timestamp || 0) / 1000);
        if (!this.indexes.byTimestamp.has(timestamp)) {
          this.indexes.byTimestamp.set(timestamp, new Set());
        }
        this.indexes.byTimestamp.get(timestamp).add(id);

        if (memory.tags) {
          for (const tag of memory.tags) {
            if (!this.indexes.byTag.has(tag)) {
              this.indexes.byTag.set(tag, new Set());
            }
            this.indexes.byTag.get(tag).add(id);
          }
        }
      }
    }
  }

  async store(type, data, options = {}) {
    const id = options.id || this._generateId(type, data);
    const memory = {
      id,
      type,
      data,
      timestamp: Date.now(),
      priority: options.priority || PRIORITY.NORMAL,
      tags: options.tags || [],
      metadata: options.metadata || {},
      accessCount: 0,
      lastAccess: Date.now(),
    };

    if (!this.db[type]) {
      this.db[type] = new Map();
    }
    this.db[type].set(id, memory);

    this._updateIndexes(type, id, memory);
    this.stats.writes++;

    this.logger.debug(`Stored memory: ${type}/${id}`);
    this.emit?.('store', { type, id, memory });

    return memory;
  }

  async retrieve(type, id) {
    this.stats.reads++;
    const memory = this.db[type]?.get(id);

    if (memory) {
      memory.accessCount++;
      memory.lastAccess = Date.now();
      this.stats.hits++;
      this.logger.debug(`Retrieved memory: ${type}/${id}`);
      return memory;
    }

    this.stats.misses++;
    this.logger.debug(`Memory miss: ${type}/${id}`);
    return null;
  }

  async query(type, filters = {}) {
    const results = [];
    const memories = this.db[type] || new Map();

    for (const [id, memory] of memories) {
      let match = true;

      if (filters.tags?.length) {
        const hasAllTags = filters.tags.every((tag) => memory.tags?.includes(tag));
        if (!hasAllTags) match = false;
      }

      if (filters.priority !== undefined && memory.priority !== filters.priority) {
        match = false;
      }

      if (filters.minAge !== undefined) {
        const age = Date.now() - memory.timestamp;
        if (age < filters.minAge) match = false;
      }

      if (filters.maxAge !== undefined) {
        const age = Date.now() - memory.timestamp;
        if (age > filters.maxAge) match = false;
      }

      if (filters.since !== undefined && memory.timestamp < filters.since) {
        match = false;
      }

      if (filters.until !== undefined && memory.timestamp > filters.until) {
        match = false;
      }

      if (filters.search) {
        const searchLower = filters.search.toLowerCase();
        const dataStr = JSON.stringify(memory.data).toLowerCase();
        if (!dataStr.includes(searchLower)) match = false;
      }

      if (match) results.push(memory);
    }

    if (filters.sortBy === 'timestamp') {
      results.sort((a, b) => b.timestamp - a.timestamp);
    } else if (filters.sortBy === 'priority') {
      results.sort((a, b) => b.priority - a.priority);
    } else if (filters.sortBy === 'accessCount') {
      results.sort((a, b) => b.accessCount - a.accessCount);
    }

    if (filters.limit) {
      return results.slice(0, filters.limit);
    }

    return results;
  }

  async update(type, id, updates) {
    const memory = await this.retrieve(type, id);
    if (!memory) {
      throw new Error(`Memory not found: ${type}/${id}`);
    }

    const updated = {
      ...memory,
      ...updates,
      id,
      type,
      timestamp: memory.timestamp,
    };

    this.db[type].set(id, updated);
    this._updateIndexes(type, id, updated);

    this.logger.debug(`Updated memory: ${type}/${id}`);
    this.emit?.('update', { type, id, memory: updated });

    return updated;
  }

  async delete(type, id) {
    const existed = this.db[type]?.has(id);
    if (existed) {
      this.db[type].delete(id);
      this._removeFromIndexes(type, id);
      this.logger.debug(`Deleted memory: ${type}/${id}`);
      this.emit?.('delete', { type, id });
      return true;
    }
    return false;
  }

  async forget(type, pattern) {
    const regex = new RegExp(pattern);
    const toDelete = [];

    for (const [id, memory] of this.db[type] || new Map()) {
      if (regex.test(id) || regex.test(JSON.stringify(memory.data))) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      await this.delete(type, id);
    }

    return toDelete.length;
  }

  async cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [type, memories] of Object.entries(this.db)) {
      if (type === MEMORY_TYPE.WORKING) continue;

      for (const [id, memory] of memories) {
        const age = now - memory.timestamp;
        if (age > this.config.maxMemoryAge && memory.priority < PRIORITY.HIGH) {
          await this.delete(type, id);
          cleaned++;
        }
      }
    }

    this.stats.cleanupCount++;
    this.logger.info(`Cleaned up ${cleaned} old memories`);
    return cleaned;
  }

  _generateId(type, data) {
    const content = JSON.stringify({ type, data, ts: Date.now() });
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  _updateIndexes(type, id, memory) {
    if (!this.indexes.byPriority.has(memory.priority)) {
      this.indexes.byPriority.set(memory.priority, new Set());
    }
    this.indexes.byPriority.get(memory.priority).add(id);

    if (memory.tags) {
      for (const tag of memory.tags) {
        if (!this.indexes.byTag.has(tag)) {
          this.indexes.byTag.set(tag, new Set());
        }
        this.indexes.byTag.get(tag).add(id);
      }
    }
  }

  _removeFromIndexes(type, id) {
    for (const [priority, ids] of this.indexes.byPriority) {
      ids.delete(id);
    }

    for (const [, ids] of this.indexes.byTag) {
      ids.delete(id);
    }
  }

  async close() {
    await this._saveToDisk();
    this.logger.info('Memory store closed');
  }

  getStats() {
    return {
      ...this.stats,
      totalMemories: Array.from(Object.values(this.db)).reduce((sum, m) => sum + m.size, 0),
      byType: Object.fromEntries(
        Object.entries(this.db).map(([type, memories]) => [type, memories.size]),
      ),
    };
  }

  async export(filter = {}) {
    const allMemories = [];

    for (const [type, memories] of Object.entries(this.db)) {
      if (filter.type && filter.type !== type) continue;

      for (const memory of memories.values()) {
        allMemories.push(memory);
      }
    }

    return allMemories;
  }

  async import(memories) {
    for (const memory of memories) {
      await this.store(memory.type, memory.data, {
        id: memory.id,
        priority: memory.priority,
        tags: memory.tags,
        metadata: memory.metadata,
      });
    }
  }
}

export class ContextualMemory extends MemoryStore {
  constructor(config = {}) {
    super(config);
    this.contexts = new Map();
  }

  async pushContext(contextId, memory) {
    if (!this.contexts.has(contextId)) {
      this.contexts.set(contextId, []);
    }
    const context = this.contexts.get(contextId);
    context.push(memory);

    if (context.length > (this.config.contextLimit || 100)) {
      context.shift();
    }

    await this.store(
      MEMORY_TYPE.EPISODIC,
      {
        contextId,
        memory,
        sequence: context.length,
      },
      {
        tags: [`context:${contextId}`],
        priority: PRIORITY.NORMAL,
      },
    );

    return context;
  }

  async getContext(contextId, limit = 10) {
    const memories = await this.query(MEMORY_TYPE.EPISODIC, {
      tags: [`context:${contextId}`],
      limit,
    });

    return memories.map((m) => m.data.memory).reverse();
  }

  async mergeContext(contextId, summary) {
    return this.store(
      MEMORY_TYPE.SEMANTIC,
      {
        contextId,
        summary,
        merged: true,
      },
      {
        tags: [`context:${contextId}`, 'merged'],
        priority: PRIORITY.HIGH,
      },
    );
  }
}
