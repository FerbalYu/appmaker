const http = require('http');
const path = require('path');
const fs = require('fs');

class ProgressMonitor {
  constructor(engine, port = 8088) {
    this.engine = engine;
    this.port = port;
    this.clients = new Set();
    this.server = null;
    this.history = []; // Keep a short history to initialize new clients

    // Hook into engine events
    this._hookEvents();
  }

  _hookEvents() {
    const eventsToForward = [
      'milestone:start', 'milestone:done',
      'task:start', 'task:done', 'task:error', 'task:review'
    ];

    eventsToForward.forEach(eventName => {
      this.engine.on(eventName, (data) => {
        this._broadcast(eventName, data);
      });
    });

    this.engine.on('plan:start', (data) => {
      this._broadcast('plan:start', data);
    });
  }

  _broadcast(event, data) {
    // Keep a slim history representation for new connections
    const payload = JSON.stringify({ event, data });
    
    // Simplistic history pruning to stop memory leaks
    if (this.history.length > 100) this.history.shift();
    this.history.push({ event, data });

    for (const client of this.clients) {
      client.write(`data: ${payload}\n\n`);
    }
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        
        // Send previous events to synchronize the new client
        for (const historyItem of this.history) {
          res.write(`data: ${JSON.stringify(historyItem)}\n\n`);
        }

        this.clients.add(res);
        req.on('close', () => {
          this.clients.delete(res);
        });
        return;
      }

      // 静态服务
      if (req.url === '/' || req.url === '/index.html') {
        const filePath = path.join(__dirname, 'public', 'index.html');
        fs.readFile(filePath, (err, content) => {
          if (err) {
            res.writeHead(500);
            res.end('Error loading dashboard');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(content);
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        resolve(`http://localhost:${this.port}`);
      });
      // 避免端口冲突自动寻址
      this.server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
          this.port++;
          this.server.listen(this.port);
        }
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }
}

module.exports = { ProgressMonitor };
