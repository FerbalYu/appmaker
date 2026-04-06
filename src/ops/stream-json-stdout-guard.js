export const STDOUT_GUARD_MARKER = '[stdout-guard]';

let installed = false;
let buffered = '';
let originalWrite = null;

function isJsonLine(line) {
  if (line.length === 0) {
    return true;
  }
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

export function installStreamJsonStdoutGuard() {
  if (installed) {
    return;
  }
  installed = true;
  originalWrite = process.stdout.write.bind(process.stdout);

  process.stdout.write = function patchedStdoutWrite(chunk, encodingOrCb, cb) {
    const text =
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    buffered += text;

    let newlineIndex = -1;
    let wrote = true;
    while ((newlineIndex = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      if (isJsonLine(line)) {
        wrote = originalWrite(line + '\n');
      } else {
        process.stderr.write(`${STDOUT_GUARD_MARKER} ${line}\n`);
      }
    }

    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (typeof callback === 'function') {
      queueMicrotask(() => callback());
    }
    return wrote;
  };
}

export function resetStreamJsonStdoutGuardForTesting() {
  if (originalWrite) {
    process.stdout.write = originalWrite;
    originalWrite = null;
  }
  buffered = '';
  installed = false;
}

