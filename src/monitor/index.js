import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ProgressMonitor {
  constructor(eventBus, port = 8088) {
    this.bus = eventBus;
    this.port = port;
    this.clients = new Set();
    this.server = null;
    this.history = [];

    this._hookEvents();
  }

  _hookEvents() {
    const eventsToForward = [
      'think:start',
      'think:message',
      'think:done',
      'plan:start',
      'plan:done',
      'plan:ready',
      'milestone:start',
      'milestone:done',
      'task:start',
      'task:done',
      'task:error',
      'task:review',
      'task:progress',
      'task:retry_wait',
      'agent:action',
      'execution:done',
    ];

    eventsToForward.forEach((eventName) => {
      this.bus.on(eventName, (data) => {
        this._broadcast(eventName, data);
      });
    });
  }

  _broadcast(event, data) {
    const payload = JSON.stringify({ event, data });

    if (this.history.length > 100) this.history.shift();
    this.history.push({ event, data });

    for (const { controller } of this.clients) {
      try {
        controller.enqueue(`data: ${payload}\n\n`);
      } catch {
        /* client disconnected */
      }
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      const tryListen = (port) => {
        try {
          this.server = Bun.serve({
            port,
            idleTimeout: 0,
            fetch: (req) => this._handleRequest(req),
            error: (err) => {
              if (err.code === 'EADDRINUSE') {
                // Port busy, try next
                this.server?.stop();
                tryListen(port + 1);
              } else {
                reject(err);
              }
            },
          });
          this.port = this.server.port;
          resolve(`http://localhost:${this.port}`);
        } catch (err) {
          if (err.code === 'EADDRINUSE') {
            tryListen(port + 1);
          } else {
            reject(err);
          }
        }
      };

      tryListen(this.port);
    });
  }

  _handleRequest(req) {
    const url = new URL(req.url);

    // SSE 事件流
    if (url.pathname === '/events') {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // 发送历史事件给新连接者
      const clientRef = { controller: { enqueue: (chunk) => writer.write(encoder.encode(chunk)) } };
      this.clients.add(clientRef);

      // 推送历史
      for (const item of this.history) {
        writer.write(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
      }

      // 当客户端断开时清理
      req.signal?.addEventListener('abort', () => {
        this.clients.delete(clientRef);
        writer.close().catch(() => {});
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // 静态 HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
      try {
        const content = readFileSync(path.join(__dirname, 'public', 'index.html'));
        return new Response(content, {
          headers: { 'Content-Type': 'text/html' },
        });
      } catch {
        return new Response('Error loading dashboard', { status: 500 });
      }
    }

    return new Response(null, { status: 404 });
  }

  stop() {
    if (this.server) {
      this.server.stop();
    }
    for (const { controller } of this.clients) {
      try {
        controller.enqueue('');
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
