import { EventEmitter } from 'events';
import { createInterface } from 'readline';

/**
 * 通用的 ACP (Agent Client Protocol) Client 基于 JSON-RPC 2.0
 * 使用 Bun.spawn 替代 cross-spawn，彻底解决 Windows EINVAL 问题
 */
export class ACPClient extends EventEmitter {
  constructor(cmd, args, options = {}, name = 'acp-client') {
    super();
    this.cmd = cmd;
    this.args = args;
    this.options = options;
    this.name = name;
    this.process = null;
    this.messageId = 1;
    this.pendingRequests = new Map();
    this.rl = null;
  }

  async start(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      try {
        // Bun.spawn：无 EINVAL，原生跨平台，Windows 友好
        this.process = Bun.spawn([this.cmd, ...this.args], {
          cwd: this.options.cwd || process.cwd(),
          env: { ...process.env, ...(this.options.env || {}) },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe'
        });
      } catch (err) {
        return reject(err);
      }

      // 读取 stderr 流
      this._pipeStream(this.process.stderr, (data) => {
        this.emit('stderr', data);
      });

      // 用 readline 逐行解析 stdout（JSON-RPC 协议）
      this.rl = createInterface({
        input: this.process.stdout,
        terminal: false
      });

      this.rl.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed) this._handleRPCMessage(trimmed);
      });

      // 进程退出时清理所有 pending requests
      this.process.exited.then((exitCode) => {
        this.emit('close', exitCode);
        for (const [id, req] of this.pendingRequests.entries()) {
          req.reject(new Error(`ACP Server closed unexpectedly (code ${exitCode}). RPC ID: ${id}`));
        }
        this.pendingRequests.clear();
      });

      const timer = setTimeout(() => {
        reject(new Error(`[${this.name}] Start timeout exceeded (${timeoutMs}ms)`));
      }, timeoutMs);

      // 发送 healthCheck 探测以确认启动成功
      this.request('system.healthCheck', {}, 5000)
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          if (err.message.includes('Method not found') || err.message.includes('timeout')) {
            if (!this.process.killed) resolve(true);
            else reject(new Error('Process dead during initialization'));
          } else {
            reject(err);
          }
        });
    });
  }

  request(method, params, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed) {
        return reject(new Error('ACP Client is not running'));
      }

      const id = this.messageId++;
      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP Request timeout (${timeoutMs}ms) for method: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        // Bun.spawn 的 stdin 是 WritableStream
        const writer = this.process.stdin.getWriter();
        writer.write(new TextEncoder().encode(JSON.stringify(payload) + '\n'));
        writer.releaseLock();
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    if (!this.process || this.process.killed) return;
    const payload = { jsonrpc: '2.0', method, params };
    try {
      const writer = this.process.stdin.getWriter();
      writer.write(new TextEncoder().encode(JSON.stringify(payload) + '\n'));
      writer.releaseLock();
    } catch { /* ignore */ }
  }

  _handleRPCMessage(line) {
    try {
      const msg = JSON.parse(line);
      if (msg.jsonrpc !== '2.0') return;

      if ('id' in msg) {
        const req = this.pendingRequests.get(msg.id);
        if (req) {
          clearTimeout(req.timer);
          this.pendingRequests.delete(msg.id);
          if ('error' in msg) {
            req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            req.resolve(msg.result);
          }
        }
      } else if ('method' in msg) {
        this.emit('notification', msg);
      }
    } catch {
      this.emit('unhandledLine', line);
    }
  }

  /**
   * 将 Bun ReadableStream 转为事件驱动
   * @private
   */
  async _pipeStream(stream, onData) {
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        onData(decoder.decode(value));
      }
    } catch { /* ignore */ }
  }

  stop() {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }
}
