const fs = require('fs').promises;
const path = require('path');

class Logger {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(process.cwd(), '.appmaker', 'logs');
    this.level = options.level || 'info';
    this.initialized = false;
  }

  async _init() {
    if (this.initialized) return;
    await fs.mkdir(path.join(this.logDir, 'execution'), { recursive: true });
    await fs.mkdir(path.join(this.logDir, 'quality'), { recursive: true });
    await fs.mkdir(path.join(this.logDir, 'corrections'), { recursive: true });
    await fs.mkdir(this.logDir, { recursive: true });
    this.initialized = true;
  }

  async _writeLog(category, filename, message) {
    await this._init();
    
    // 如果 category 为空，则写入根 logDir (例如 supervisor.log)
    const targetDir = category ? path.join(this.logDir, category) : this.logDir;
    const filepath = path.join(targetDir, filename);
    const timestamp = new Date().toISOString();
    
    // 如果是对象尝试格式化
    let content = message;
    if (typeof message === 'object') {
      content = JSON.stringify(message, null, 2);
    }

    const line = `[${timestamp}] ${content}\n`;
    try {
      await fs.appendFile(filepath, line, 'utf-8');
    } catch {
      // Ignore
    }
  }

  async log(level, category, filename, message, meta = {}) {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    const prefix = level === 'ERROR' ? '\x1b[31m' : level === 'WARN' ? '\x1b[33m' : '';
    const suffix = prefix ? '\x1b[0m' : '';
    
    console.log(`${prefix}[${level}]${category ? `[${category}]` : ''} ${message}${suffix}`);
    await this._writeLog(category, filename, `[${level}] ${message}${metaStr}`);
  }

  async info(category, filename, message, meta = {}) {
    return this.log('INFO', category, filename, message, meta);
  }

  async warn(category, filename, message, meta = {}) {
    return this.log('WARN', category, filename, message, meta);
  }

  async error(category, filename, message, meta = {}) {
    return this.log('ERROR', category, filename, message, meta);
  }
}

module.exports = { Logger };
