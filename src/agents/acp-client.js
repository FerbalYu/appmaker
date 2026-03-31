const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');

/**
 * 通用的 ACP (Agent Client Protocol) Client 基于 JSON-RPC 2.0
 */
class ACPClient extends EventEmitter {
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
      const crossSpawn = require('cross-spawn');
      const spawnOpts = {
        ...this.options,
        env: { ...process.env, ...this.options.env }
      };

      try {
        this.process = crossSpawn(this.cmd, this.args, spawnOpts);
      } catch (err) {
        return reject(err);
      }

      this.rl = readline.createInterface({
        input: this.process.stdout,
        output: null,
        terminal: false
      });

      this.process.stderr.on('data', (data) => {
        // 部分 Agent 会往 stderr 打印日志或进度，抛出事件交由外界处理
        this.emit('stderr', data.toString());
      });

      this.process.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.process.on('close', (code) => {
        this.emit('close', code);
        for (const [id, req] of this.pendingRequests.entries()) {
          req.reject(new Error(`ACP Server closed unexpectedly (code ${code}). RPC ID: ${id}`));
        }
        this.pendingRequests.clear();
      });

      this.rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        this._handleRPCMessage(trimmed);
      });

      const timer = setTimeout(() => {
        reject(new Error(`[${this.name}] Start timeout exceeded (${timeoutMs}ms)`));
      }, timeoutMs);

      // 发送一个内置的方法探测 (initialize / serverInfo) 来判断启动成功
      this.request('system.healthCheck', {}, 5000)
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          // 如果 Agent 没有提供这个内置接口也不要紧，只要不报错且进程存活就算成功
          clearTimeout(timer);
          if (err.message.includes('Method not found') || err.message.includes('timeout')) {
             if (this.process.killed === false) resolve(true);
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
        this.process.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    if (!this.process || this.process.killed) return;
    const payload = {
      jsonrpc: '2.0',
      method,
      params
    };
    try {
      this.process.stdin.write(JSON.stringify(payload) + '\n');
    } catch(e) {}
  }

  _handleRPCMessage(line) {
    try {
      const msg = JSON.parse(line);
      if (msg.jsonrpc !== '2.0') return;

      // 响应
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
        // 本地收到 server 发来的 notification / request
        this.emit('notification', msg);
      }
    } catch (err) {
      // 忽略非 JSON 行 (可能是调试或系统输出的干扰)
      this.emit('unhandledLine', line);
    }
  }

  stop() {
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }
}

module.exports = { ACPClient };
