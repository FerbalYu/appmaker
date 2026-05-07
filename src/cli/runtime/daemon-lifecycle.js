import { createDaemon } from '../../daemon/index.js';

export async function startDaemon({ daemonDataDir, executeDir }) {
  console.log('🔮 初始化持久守护进程...\n');

  const daemon = await createDaemon({
    dataDir: daemonDataDir,
    heartbeatInterval: 30000,
    autoSaveInterval: 60000,
    recoveryEnabled: true,
  });

  daemon.on('heartbeat', (health) => {
    if (process.env.DEBUG) {
      console.log(`💓 心跳 [${new Date().toLocaleTimeString()}]`, {
        state: health.state,
        memory: Math.round(health.memory.heapUsed / 1024 / 1024) + 'MB',
      });
    }
  });

  await daemon.start();
  console.log(`✅ 守护进程已启动 (PID: ${daemon.pid})\n`);

  return daemon;
}

export async function stopDaemon(daemon, { daemonDataDir, executeDir }) {
  if (!daemon) return;

  await daemon.saveState();
  await daemon.stop();
  console.log('\n🔮 运行状态已持久化保存至守护进程数据目录。');
  console.log(`   数据目录: ${daemonDataDir}`);
  console.log(`   查看状态: bun cli.js daemon --dir "${executeDir}"`);
}

export async function safeStopDaemon(daemon) {
  if (!daemon) return;
  try {
    await daemon.saveState();
    await daemon.stop();
  } catch (e) {
    // ignore
  }
}
