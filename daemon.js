#!/usr/bin/env bun
/**
 * Daemon CLI - 持久守护进程命令行工具
 * 支持后台运行、交互模式、状态查看等
 */

import { runDaemon } from './src/daemon/index.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const command = args[0];

let workingDir = process.cwd();
let dataDir = null;
let interactive = true;
let background = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir' && args[i + 1]) {
    workingDir = path.resolve(process.cwd(), args[i + 1]);
    i++;
  } else if (args[i] === '--data-dir' && args[i + 1]) {
    dataDir = path.resolve(process.cwd(), args[i + 1]);
    i++;
  } else if (args[i] === '--no-interactive') {
    interactive = false;
  } else if (args[i] === '--background' || args[i] === '-d') {
    background = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    showHelp();
    process.exit(0);
  }
}

async function main() {
  try {
    switch (command) {
      case 'start':
      case undefined:
        await cmdStart();
        break;

      case 'stop':
        await cmdStop();
        break;

      case 'status':
        await cmdStatus();
        break;

      case 'restart':
        await cmdRestart();
        break;

      case 'test':
        await cmdTest();
        break;

      default:
        console.error(`未知命令: ${command}`);
        showHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error('\x1b[31mFatal Error:\x1b[0m', error.message);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

async function cmdStart() {
  const daemonDataDir = dataDir || path.join(workingDir, '.daemon');

  console.log('='.repeat(60));
  console.log('🔮 appMaker Daemon - 持久守护进程');
  console.log('='.repeat(60));
  console.log('工作目录:', workingDir);
  console.log('数据目录:', daemonDataDir);
  console.log();

  const daemon = await runDaemon({
    workingDir,
    dataDir: daemonDataDir,
    interactive,
    heartbeatInterval: 30000,
    autoSaveInterval: 60000,
    recoveryEnabled: true,
    maxRetries: 3
  });

  if (interactive) {
    process.on('SIGINT', async () => {
      console.log('\n\n正在停止守护进程...');
      await daemon.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await daemon.stop();
      process.exit(0);
    });
  }
}

async function cmdStop() {
  const daemonDataDir = dataDir || path.join(workingDir, '.daemon');
  const pidFile = path.join(daemonDataDir, 'daemon.pid');

  try {
    const pidData = await fs.readFile(pidFile, 'utf-8');
    const pid = parseInt(pidData);

    console.log(`正在停止 PID ${pid} 的守护进程...`);

    process.kill(pid, 'SIGTERM');

    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log('✅ 守护进程已停止');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('守护进程未运行');
    } else {
      console.error('停止失败:', error.message);
    }
  }
}

async function cmdStatus() {
  const daemonDataDir = dataDir || path.join(workingDir, '.daemon');

  try {
    const stateFile = path.join(daemonDataDir, 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

    console.log('\n📊 守护进程状态:');
    console.log('  状态:', state.state);
    console.log('  PID:', state.pid);
    console.log('  运行时长:', Math.floor((Date.now() - state.startTime) / 1000) + 's');
    console.log('  重启次数:', state.stats?.restartCount || 0);
    console.log('  已处理任务:', state.stats?.tasksProcessed || 0);
    console.log('  会话总数:', state.stats?.sessionsCreated || 0);
    console.log();

    const heartbeatFile = path.join(daemonDataDir, 'heartbeat.json');
    const heartbeat = JSON.parse(await fs.readFile(heartbeatFile, 'utf-8'));
    console.log('💓 最新心跳:');
    console.log('  状态:', heartbeat.state);
    console.log('  内存使用:', Math.round(heartbeat.memory.heapUsed / 1024 / 1024) + 'MB');
    console.log('  时间:', new Date(heartbeat.timestamp).toLocaleString());
    console.log();
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('守护进程未运行或数据目录不存在');
    } else {
      throw error;
    }
  }
}

async function cmdRestart() {
  console.log('正在重启守护进程...');
  await cmdStop();
  await new Promise(resolve => setTimeout(resolve, 1000));
  await cmdStart();
}

async function cmdTest() {
  console.log('🧪 运行守护进程测试...\n');

  const { testDaemon } = await import('./src/daemon/test-daemon.js');
  await testDaemon();
}

function showHelp() {
  console.log(`
🔮 appMaker Daemon - 持久守护进程

用法:
  bun daemon.js [命令] [选项]

命令:
  start              启动守护进程（默认）
  stop               停止守护进程
  status             查看守护进程状态
  restart            重启守护进程
  test               运行测试

选项:
  --dir <路径>       指定工作目录（默认: 当前目录）
  --data-dir <路径>  指定数据目录（默认: <工作目录>/.daemon）
  --no-interactive   禁用交互模式
  --background, -d   后台运行
  --help, -h         显示帮助信息

示例:
  bun daemon.js start --dir ./my-project
  bun daemon.js status --dir ./my-project
  bun daemon.js start --background
  `);
}

main();
