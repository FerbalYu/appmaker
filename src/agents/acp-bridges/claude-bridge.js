#!/usr/bin/env node
/**
 * ACP Bridge for Claude Code
 * 作为标准的 Agent Client Protocol (ACP) Server 运行
 * 从 stdin 接收 JSON-RPC 请求，执行 claude cli 并把结果包装回 JSON-RPC
 */
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');

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
      sendResponse(msg.id, { status: 'ok', name: 'claude-acp-bridge' });
      return;
    }

    if (msg.method === 'execute') {
      await handleExecute(msg.id, msg.params);
    } else {
      sendError(msg.id, -32601, 'Method not found');
    }
  } catch (err) {
    // 忽略无法解析的输入
  }
});

async function handleExecute(id, params) {
  const { prompt, context, timeout = 120000 } = params;
  
  const cwd = (context && context.project_root) ? context.project_root : process.cwd();
  
  // 查找 claude clijs
  let cliPath = 'C:\\Program Files\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  if (!fs.existsSync(cliPath)) {
    // 尝试找本地
    try {
      cliPath = require.resolve('@anthropic-ai/claude-code/cli.js');
    } catch(e) {
      cliPath = 'claude';
    }
  }

  let child;
  if (cliPath.endsWith('.js')) {
    child = spawn(process.execPath, [cliPath, '--print', '--input-format', 'text', '--output-format', 'json'], {
      cwd,
      env: { ...process.env, CLAUDECODE: '' }
    });
  } else {
    const crossSpawn = require('cross-spawn');
    child = crossSpawn('claude', ['--print', '--input-format', 'text', '--output-format', 'json'], {
      cwd,
      env: { ...process.env, CLAUDECODE: '' }
    });
  }

  let outputStr = '';
  let killed = false;

  const timer = setTimeout(() => {
    killed = true;
    child.kill();
    sendError(id, -32000, `Execution timeout (${timeout}ms)`);
  }, timeout);

  child.stdout.on('data', data => { outputStr += data.toString(); });
  child.stderr.on('data', data => { 
    sendNotification('agent/stderr', { data: data.toString() });
  });

  child.on('error', err => {
    if (killed) return;
    clearTimeout(timer);
    sendError(id, -32001, err.message);
  });

  child.on('close', code => {
    if (killed) return;
    clearTimeout(timer);
    
    // 解析输出 (容错解析，避免截断和噪音)
    try {
      let finalObj = null;
      const lines = outputStr.split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.type === 'result' || parsed.success !== undefined || parsed.is_error !== undefined) {
             finalObj = parsed;
             break;
          }
        } catch(e) {}
      }

      if (finalObj) {
         sendResponse(id, {
           files_created: finalObj.files_created || [],
           files_modified: finalObj.files_modified || [],
           summary: finalObj.result || finalObj.content || finalObj.summary || JSON.stringify(finalObj),
           tests_run: finalObj.tests_run || false,
           success: finalObj.is_error !== true
         });
         return;
      }
      
      // 如果没有找到明确的 json 行
      sendResponse(id, { summary: outputStr, success: code === 0 });
    } catch(e) {
      sendResponse(id, { summary: outputStr, success: code === 0 });
    }
  });

  // 等待 stdin 准备好后再写入
  child.stdin.write(prompt + '\n');
  child.stdin.end();
}
