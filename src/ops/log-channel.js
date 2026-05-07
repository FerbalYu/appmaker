export class LogChannel {
  constructor(opts = {}) {
    this.stdout = opts.stdout || console.log;
    this.stderr = opts.stderr || console.error;
    this.prefix = opts.prefix || '';
    this.jsonMode = opts.jsonMode || false;
  }

  info(msg, meta = {}) {
    this._write('INFO', msg, meta, this.stdout);
  }

  warn(msg, meta = {}) {
    this._write('WARN', msg, meta, this.stderr);
  }

  error(msg, meta = {}) {
    this._write('ERROR', msg, meta, this.stderr);
  }

  debug(msg, meta = {}) {
    this._write('DEBUG', msg, meta, this.stderr);
  }

  withPrefix(prefix) {
    return new LogChannel({
      stdout: this.stdout,
      stderr: this.stderr,
      prefix: this.prefix ? `${this.prefix} ${prefix}` : prefix,
      jsonMode: this.jsonMode,
    });
  }

  _write(level, msg, meta, target) {
    if (this.jsonMode) {
      target(JSON.stringify({ type: 'log', level, message: msg, ...meta }));
      return;
    }

    const prefix = this.prefix ? `[${this.prefix}]` : '';
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';

    switch (level) {
      case 'ERROR':
        target(`\x1b[31m[ERROR]${prefix} ${msg}${metaStr}\x1b[0m`);
        break;
      case 'WARN':
        target(`\x1b[33m[WARN]${prefix} ${msg}${metaStr}\x1b[0m`);
        break;
      default:
        target(`[${level}]${prefix} ${msg}${metaStr}`);
    }
  }
}

export const defaultChannel = new LogChannel();
