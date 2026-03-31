#!/usr/bin/env node
/**
 * ACP Bridge for OpenCode
 * 作为标准的 Agent Client Protocol (ACP) Server 运行
 * 从 stdin 接收 JSON-RPC 请求，执行 opencode cli 并把结果包装回 JSON-RPC
 */
const { spawn, execSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function sendNotification(method, params) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.jsonrpc !== '2.0') return;

    if (msg.method === 'system.healthCheck') {
      sendResponse(msg.id, { status: 'ok', name: 'opencode-acp-bridge' });
      return;
    }

    if (msg.method === 'review') {
      await handleReview(msg.id, msg.params);
    } else {
      sendError(msg.id, -32601, 'Method not found');
    }
  } catch (err) {
    // 忽略
  }
});

async function handleReview(id, params) {
  const { prompt, context, timeout = 60000 } = params;
  const cwd = (context && context.project_root) ? context.project_root : process.cwd();
  
  let cliPath = 'opencode';
  const args = ['run', prompt];
  if (context && context.project_root) {
    args.push('--project', context.project_root);
  }

  let cmdToRun = cliPath;
  let finalArgs = [...args];
  let isWin = process.platform === 'win32';

  if (isWin) {
    try {
      const cmdOutput = execSync(`where ${cliPath}.cmd 2>NUL`).toString().trim();
      if (cmdOutput) {
        const binPath = cmdOutput.split('\n')[0].trim();
        const content = fs.readFileSync(binPath, 'utf-8');
        const matches = [...content.matchAll(/"(%~?dp0%?[^"]+)"/ig)];
        if (matches.length > 0) {
          const lastMatch = matches[matches.length - 1];
          const jsScript = lastMatch[1].replace(/%~?dp0%?\\?/, path.dirname(binPath) + path.sep);
          cmdToRun = process.execPath;
          finalArgs = [jsScript, ...args];
        } else {
          cmdToRun = binPath;
        }
      } else {
        cmdToRun = cliPath.endsWith('.cmd') ? cliPath : `${cliPath}.cmd`;
      }
    } catch(e) {
      cmdToRun = cliPath.endsWith('.cmd') ? cliPath : `${cliPath}.cmd`;
    }
  }

  // 开始执行由于 opencode 不是常驻 json 服务，我们直接封装成 RPC 调用。
  let stdoutData = '';
  let stderrData = '';
  
  const child = spawn(cmdToRun, finalArgs, {
    cwd,
    shell: isWin && cmdToRun !== process.execPath, 
    env: process.env
  });

  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    sendError(id, -32000, `Execution timeout (${timeout}ms)`);
  }, timeout);

  child.stdout.on('data', data => { 
    stdoutData += data.toString(); 
  });
  
  child.stderr.on('data', data => { 
    stderrData += data.toString();
    sendNotification('agent/stderr', { data: data.toString() });
  });

  child.on('error', err => {
    clearTimeout(timer);
    sendError(id, -32001, err.message);
  });

  child.on('close', code => {
    clearTimeout(timer);
    if (code !== 0 && !stdoutData) {
      sendError(id, -32002, `Command failed: ${stderrData}`);
      return;
    }
    
    try {
      const resultObjStr = _extractJSON(stdoutData);
      sendResponse(id, JSON.parse(resultObjStr));
    } catch(e) {
       sendResponse(id, { output: stdoutData, success: true });
    }
  });

  function _extractJSON(output) {
    if (typeof output !== 'string') return JSON.stringify(output);
    const codeBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) return codeBlockMatch[1].trim();
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return output.substring(start, end + 1);
    }
    return output;
  }
}
