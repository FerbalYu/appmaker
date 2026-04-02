#!/usr/bin/env bun
/**
 * NexusCodeForge (NCF) CLI
 * 执行双 Agent 协作流程（集成持久守护进程）
 *
 * 用法:
 *   bun cli.js health                    检查 Agent
 *   bun cli.js plan "需求描述"           生成计划
 *   bun cli.js execute plan.json         执行计划文件
 *   bun cli.js run "需求描述"            自动生成计划并执行（推荐）
 */

// Bun 自动加载 .env，无需 dotenv

import { createEngine, healthCheck } from './src/agents/index.js';
import { Planner } from './src/planner.js';
import { Supervisor } from './src/supervisor.js';
import { ProgressMonitor } from './src/monitor/index.js';
import { createDaemon, DAEMON_STATE } from './src/daemon/index.js';
import { MultiAgentThinker } from './src/thinker.js';
import { AssetScoutAdapter } from './src/agents/asset-scout.js';
import { promises as fs } from 'fs';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { exec } from 'child_process';
import { EventEmitter } from 'events';

const globalBus = new EventEmitter();
let isMonitorStarted = false;

async function startMonitor() {
  if (isMonitorStarted) return;
  const monitor = new ProgressMonitor(globalBus, 8088);
  const monitorUrl = await monitor.start();
  console.log(`\x1b[36m🚀 已开启智能进度看板: ${monitorUrl}\x1b[0m\n`);
  if (process.platform === 'win32') exec(`start ${monitorUrl}`);
  else if (process.platform === 'darwin') exec(`open ${monitorUrl}`);
  else exec(`xdg-open ${monitorUrl}`);
  isMonitorStarted = true;
  return monitor;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const command = args[0];

let executeDir = process.cwd();
let daemonDataDir = null;
let daemonMode = true;

const dirIndex = args.indexOf('--dir');
if (dirIndex !== -1 && args[dirIndex + 1]) {
  executeDir = path.resolve(process.cwd(), args[dirIndex + 1]);
  args.splice(dirIndex, 2);
}

const daemonIndex = args.indexOf('--no-daemon');
if (daemonIndex !== -1) {
  daemonMode = false;
  args.splice(daemonIndex, 1);
}

const mockIndex = args.findIndex((arg) => arg === '--mock' || arg === '--dry-run');
if (mockIndex !== -1) {
  process.env.NCF_MOCK = '1';
  console.log(
    '\x1b[33m🚀 警告: 已启用 MOCK/DRY-RUN 模式，所有写操作和命令执行将被沙箱模拟。\x1b[0m',
  );
  args.splice(mockIndex, 1);
}

const mainDir = path.resolve(__dirname);
const safeExecDir = executeDir.toLowerCase();
const safeMainDir = mainDir.toLowerCase();

if (safeExecDir === safeMainDir || safeExecDir.startsWith(safeMainDir + path.sep)) {
  console.error('\\x1b[31m错误: 禁止在主程序文件夹下工作！\\x1b[0m');
  console.error(`请使用 --dir 参数指定另一工作目录，例如:`);
  console.error(`  bun cli.js run "需求描述" --dir ./my-project`);
  console.error(`  bun cli.js run "需求描述" --dir D:\\projects\\my-app`);
  process.exit(1);
}

daemonDataDir = path.join(executeDir, '.daemon');

process.on('unhandledRejection', (error) => {
  console.error('\x1b[31mUnhandled Rejection:\x1b[0m', error?.message || error);
  if (process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
});

process.on('uncaughtException', (error) => {
  console.error('\x1b[31mUnhandled Exception:\x1b[0m', error?.message || error);
  if (process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
});

let globalDaemon = null;

async function main() {
  try {
    console.log('='.repeat(50));
    console.log('NexusCodeForge (NCF) - AI 驱动的跨界开发引擎');
    console.log('工作目录: ' + executeDir);
    console.log('='.repeat(50));
    console.log();

    if (daemonMode) {
      console.log('🔮 初始化持久守护进程...\n');
      globalDaemon = await createDaemon({
        dataDir: daemonDataDir,
        heartbeatInterval: 30000,
        autoSaveInterval: 60000,
        recoveryEnabled: true,
      });

      globalDaemon.on('heartbeat', (health) => {
        if (process.env.DEBUG) {
          console.log(`💓 心跳 [${new Date().toLocaleTimeString()}]`, {
            state: health.state,
            memory: Math.round(health.memory.heapUsed / 1024 / 1024) + 'MB',
          });
        }
      });

      await globalDaemon.start();
      console.log(`✅ 守护进程已启动 (PID: ${globalDaemon.pid})\n`);
    }

    switch (command) {
      case 'health':
      case '--health':
      case 'h':
        await cmdHealth();
        break;

      case 'plan':
      case '--plan':
      case 'p':
        await cmdPlan(args[1]);
        break;

      case 'execute':
      case '--execute':
      case 'e':
        await cmdExecute(args[1]);
        break;

      case 'run':
      case '--run':
      case 'r':
        await cmdRun(args[1]);
        break;

      case 'think':
      case '--think':
      case 't':
        await cmdThink();
        break;

      case 'daemon':
      case 'd':
        await cmdDaemonStatus();
        break;

      case 'status':
      case 's':
        await cmdStatus();
        break;

      case 'logs':
      case 'l':
        await cmdLogs(args[1]);
        break;

      case 'config':
      case 'c':
        await cmdConfig(args[1], args[2]);
        break;

      case 'help':
      case '--help':
      case '-h':
        showHelp();
        break;

      case 'version':
      case 'v':
        console.log('NexusCodeForge v2.0.0');
        break;

      default:
        if (command) {
          console.error(`\x1b[31m未知命令: ${command}\x1b[0m`);
        }
        showHelp();
        process.exit(1);
    }

    if (globalDaemon) {
      await globalDaemon.saveState();
      await globalDaemon.stop();
      console.log('\n🔮 运行状态已持久化保存至守护进程数据目录。');
      console.log(`   数据目录: ${daemonDataDir}`);
      console.log(`   查看状态: bun cli.js daemon --dir "${executeDir}"`);
    }

    process.exit(process.exitCode || 0);
  } catch (error) {
    if (globalDaemon) {
      try {
        await globalDaemon.saveState();
        await globalDaemon.stop();
      } catch (e) {
        // ignore
      }
    }
    console.error('\x1b[31mFatal Error:\x1b[0m', error?.message || error);
    if (process.env.DEBUG) console.error(error.stack);
    process.exit(1);
  }
}

async function cmdDaemonStatus() {
  const { promises: fs } = await import('fs');
  const stateFile = path.join(daemonDataDir, 'state.json');

  try {
    const state = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    console.log('\n📊 守护进程状态:');
    console.log('  状态:', state.state);
    console.log('  PID:', state.pid);
    console.log('  运行时长:', Math.floor((Date.now() - state.startTime) / 1000) + 's');
    console.log('  已处理任务:', state.stats?.tasksProcessed || 0);
    console.log('  会话总数:', state.stats?.sessionsCreated || 0);
    console.log('  重启次数:', state.stats?.restartCount || 0);
    console.log();

    const memory = globalDaemon?.getMemory();
    if (memory) {
      const memStats = memory.getStats();
      console.log('🧠 记忆统计:');
      console.log('  总记忆数:', memStats.totalMemories);
      console.log('  读取:', memStats.reads);
      console.log('  写入:', memStats.writes);
      console.log();
    }

    const sessions = globalDaemon?.getSessions();
    if (sessions) {
      const allSessions = sessions.list();
      console.log('📝 会话列表:', allSessions.length);
      for (const s of allSessions.slice(0, 5)) {
        console.log(`   - ${s.name} [${s.state}]`);
      }
      console.log();
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('守护进程未运行或数据目录不存在');
    } else {
      throw error;
    }
  }
}

async function cmdHealth() {
  console.log('检查 Agent 可用性...\n');
  const status = await healthCheck();

  console.log('Agent 状态:');
  for (const [agent, available] of Object.entries(status)) {
    const icon = available ? '✓' : '✗';
    const color = available ? '\x1b[32m' : '\x1b[31m';
    console.log(`  ${color}${icon}\x1b[0m ${agent}`);
  }

  const allReady = Object.values(status).every((v) => v);
  console.log();
  if (allReady) {
    console.log('\x1b[32m所有 Agent 就绪\x1b[0m');
  } else {
    console.log('\x1b[33m部分 Agent 不可用，继续执行...\x1b[0m');
  }
}

async function cmdPlan(requirement) {
  if (!requirement) {
    console.error('\x1b[31m错误: 请提供需求描述\x1b[0m');
    console.log('用法: bun cli.js plan "做一个博客系统"');
    process.exit(1);
  }

  if (globalDaemon) {
    await globalDaemon.getMemory().store(
      'semantic',
      {
        type: 'plan_request',
        requirement,
        timestamp: Date.now(),
      },
      {
        tags: ['planning', 'intent'],
      },
    );
  }

  try {
    const planner = new Planner({ project_root: executeDir });
    const plan = await planner.plan(requirement);

    const filename = `plan_${Date.now()}.json`;
    const plansDir = path.join(executeDir, '.ncf', 'plans');
    await planner.savePlan(plan, filename, plansDir);

    console.log('\n生成的计划:');
    console.log(JSON.stringify(plan, null, 2));
  } catch (error) {
    console.error('\x1b[31mFailed to generate plan:\x1b[0m', error.message);
    if (process.env.DEBUG) console.error(error.stack);
    process.exit(1);
  }
}

async function cmdExecute(input) {
  if (!input) {
    console.error('\x1b[31m错误: 请提供计划文件或需求描述\x1b[0m');
    console.log('用法: bun cli.js execute <plan.json | "需求描述">');
    process.exit(1);
  }

  await startMonitor();

  let plan;

  if (input.endsWith('.json')) {
    try {
      await fs.access(input, fs.constants.R_OK);
    } catch {
      console.error(`\x1b[31mPlan file not found: ${input}\x1b[0m`);
      process.exit(1);
    }
    console.log(`加载计划: ${input}\n`);
    const content = await fs.readFile(input, 'utf-8');

    try {
      plan = JSON.parse(content);
    } catch (parseError) {
      console.error('\x1b[31mInvalid JSON format\x1b[0m');
      if (process.env.DEBUG) console.error(parseError.message);
      process.exit(1);
    }

    if (!plan || typeof plan !== 'object') {
      console.error('\x1b[31mError: Invalid plan format\x1b[0m');
      process.exit(1);
    }
    const steps = plan.steps || plan.tasks || plan.items;
    if (!Array.isArray(steps) || steps.length === 0) {
      console.error('\x1b[31mPlan has no steps/tasks/items\x1b[0m');
      process.exit(1);
    }
  } else {
    console.log(`从需求生成计划: "${input}"\n`);
    try {
      const planner = new Planner({ project_root: executeDir, globalBus });
      plan = await planner.plan(input);

      const filename = `plan_${Date.now()}.json`;
      const plansDir = path.join(executeDir, '.ncf', 'plans');
      await planner.savePlan(plan, filename, plansDir);
    } catch (error) {
      console.error('\x1b[31mFailed to generate plan:\x1b[0m', error.message);
      if (process.env.DEBUG) console.error(error.stack);
      process.exit(1);
    }
  }

  globalBus.emit('plan:ready', { plan });
  await executePlan(plan);
}

async function collectPlanCandidates(baseDir) {
  const candidates = [
    path.join(baseDir, '.appmaker', 'plans'),
    path.join(baseDir, '.appmaker'),
    path.join(baseDir, '.ncf', 'plans'),
    path.join(baseDir, '.ncf'),
  ];
  const planFiles = [];

  for (const dir of candidates) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.json')) continue;
        if (!entry.name.toLowerCase().includes('plan')) continue;
        const fullPath = path.join(dir, entry.name);
        const stat = await fs.stat(fullPath);
        planFiles.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // ignore missing dirs
    }
  }

  return planFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function loadLatestCheckpointTaskStatus(baseDir) {
  const checkpointDirs = [path.join(baseDir, '.appmaker', 'checkpoints'), path.join(baseDir, '.ncf', 'checkpoints')];
  const files = [];

  for (const dir of checkpointDirs) {
    try {
      const names = await fs.readdir(dir);
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const fullPath = path.join(dir, name);
        const stat = await fs.stat(fullPath);
        files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // ignore missing checkpoint dirs
    }
  }

  if (files.length === 0) return { tasks: {}, checkpoint: null };
  const latest = files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  try {
    const checkpoint = JSON.parse(await fs.readFile(latest.path, 'utf-8'));
    return { tasks: checkpoint.tasks || {}, checkpoint: latest.path };
  } catch {
    return { tasks: {}, checkpoint: latest.path };
  }
}

function extractTaskStatus(checkpointEntry) {
  if (!checkpointEntry) return '';
  if (typeof checkpointEntry === 'string') return checkpointEntry;
  return checkpointEntry.status || checkpointEntry.result?.status || '';
}

async function resolveReusablePlan(baseDir) {
  const plans = await collectPlanCandidates(baseDir);
  if (plans.length === 0) return null;

  for (const planFile of plans) {
    try {
      const plan = JSON.parse(await fs.readFile(planFile.path, 'utf-8'));
      if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) continue;

      const { tasks: checkpointTasks, checkpoint } = await loadLatestCheckpointTaskStatus(baseDir);
      const total = plan.tasks.length;
      const done = plan.tasks.filter((task) => extractTaskStatus(checkpointTasks[task.id]) === 'done').length;
      const completed = total > 0 && done === total;

      return {
        plan,
        planPath: planFile.path,
        completed,
        totalTasks: total,
        doneTasks: done,
        checkpoint,
      };
    } catch {
      // ignore broken json, continue probing
    }
  }

  return null;
}

async function cmdRun(requirement) {
  const autoYes = args.includes('--yes') || args.includes('-y');
  const actualArgs = args.filter((a) => !a.startsWith('--yes') && a !== '-y');
  const rawRequirement = actualArgs.slice(1).join(' ').trim();
  const rainmakerAutoMode = !rawRequirement;
  requirement = rainmakerAutoMode
    ? `Rainmaker 自动巡检 ${executeDir}，按“能跑 > 防坑 > 优化”生成修复计划并执行`
    : rawRequirement;

  await startMonitor();

  console.log('='.repeat(50));
  console.log('='.repeat(50));

  if (rainmakerAutoMode) {
    console.log('步骤 1: 未提供需求文案，启用 Rainmaker 全局巡检并生成修复计划');
  } else {
    console.log('步骤 1: 依据需求生成严格执行计划 (Planner)');
  }
  console.log('='.repeat(50));
  console.log();

  let plan;
  const reusablePlan = await resolveReusablePlan(executeDir);
  if (reusablePlan && !reusablePlan.completed) {
    console.log(`[Run] ♻️ 检测到未完成计划，优先续跑: ${reusablePlan.planPath}`);
    console.log(
      `[Run] 📌 已完成 ${reusablePlan.doneTasks}/${reusablePlan.totalTasks}，跳过新规划（Planner/Rainmaker）`,
    );
    if (reusablePlan.checkpoint) {
      console.log(`[Run] 使用检查点参考: ${reusablePlan.checkpoint}`);
    }
    plan = reusablePlan.plan;
    globalBus.emit('plan:ready', { plan });
  }

  if (reusablePlan && reusablePlan.completed) {
    console.log(
      `[Run] ✅ 检测到历史计划已完成 (${reusablePlan.doneTasks}/${reusablePlan.totalTasks})，继续进行新一轮规划`,
    );
  }

  try {
    if (!plan) {
      const planner = new Planner({ project_root: executeDir, globalBus });
      plan = rainmakerAutoMode
        ? await planner.planByRainmaker({ requirement })
        : await planner.plan(requirement);

      const filename = `plan_${Date.now()}.json`;
      const plansDir = path.join(executeDir, '.ncf', 'plans');
      await planner.savePlan(plan, filename, plansDir);
      globalBus.emit('plan:ready', { plan });

      if (globalDaemon) {
        await globalDaemon.getMemory().store(
          'semantic',
          {
            type: 'execution_plan',
            project: plan.project,
            taskCount: plan.tasks.length,
            milestoneCount: plan.milestones.length,
            filename,
          },
          {
            tags: ['planning', 'execution', plan.project.name],
          },
        );
      }
    }
  } catch (error) {
    console.error('\x1b[31mPlan generation failed:\x1b[0m', error.message);
    if (process.env.DEBUG) console.error(error.stack);
    process.exit(1);
  }

  console.log();
  console.log('计划摘要:');
  console.log(`  项目: ${plan.project.name}`);
  console.log(`  任务: ${plan.tasks.length} 个`);
  console.log(`  里程碑: ${plan.milestones.length} 个`);
  console.log(`  预估耗时: ${plan.metadata.total_minutes_estimate} 分钟`);
  console.log();

  let confirmed = autoYes;
  if (!autoYes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question('确认执行? (y/n): ', resolve));
    rl.close();
    confirmed = answer.toLowerCase() === 'y';
  }

  if (!confirmed) {
    console.log('已取消');
    process.exit(0);
  }

  console.log();
  console.log('='.repeat(50));
  console.log('步骤 3: 启动引擎与并行工作流');
  console.log('='.repeat(50));
  console.log();

  await executePlan(plan, requirement);
}

async function executePlan(plan, rawContext = '') {
  try {
    await fs.access(executeDir, fs.constants.W_OK);
  } catch {
    console.error(`\x1b[31mExecute directory not found or not writable: ${executeDir}\x1b[0m`);
    process.exit(1);
  }

  if (globalDaemon) {
    const session = await globalDaemon.createSession({
      name: `exec-${plan.project.name}-${Date.now()}`,
      mode: 'foreground',
      metadata: {
        project: plan.project.name,
        plan: plan.project,
      },
    });

    await globalDaemon.getMemory().store(
      'episodic',
      {
        type: 'execution_start',
        project: plan.project.name,
        sessionId: session.id,
        taskCount: plan.tasks.length,
      },
      {
        tags: ['execution', plan.project.name, 'start'],
      },
    );
  }

  console.log('开始执行计划...\n');

  // ============================
  // 后台并行素材获取预判与调用 (AssetScout)
  // ============================
  const isGameLike = /游戏|game|打怪|射击|消除|闯关|模拟|生存/i.test((plan.project?.type || '') + ' ' + (plan.project?.description || '') + ' ' + rawContext);
  if (isGameLike) {
    console.log('\\x1b[36m🤖 侦测到项目包含互动/游戏元素，正在由架构师评估是否需要启动 AssetScout 寻宝...\\x1b[0m');

    let localFilesDoc = '目录下目前没有明确的美术资源文件（如 png/jpg/wav）';
    try {
      const pubPath = path.join(executeDir, 'public');
      if (existsSync(pubPath)) {
        const files = readdirSync(pubPath, { recursive: true }).filter(f => f.match(/\\.(png|jpg|jpeg|gif|webp|svg|wav|mp3|ogg)$/i));
        if (files.length > 0) {
          localFilesDoc = `public/ 目录下已有以下素材：\\n` + files.slice(0, 10).join(', ') + (files.length > 10 ? ' ...等' : '');
        }
      }
    } catch(e) {}

    const thinker = new MultiAgentThinker({ verbose: false });
    const prompt = `【当前执行计划与已有目录状态评估】
项目：${plan.project?.name}
描述：${plan.project?.description || rawContext}
当前素材：${localFilesDoc}

请作为技术总监判断：该项目当前是否绝对需要派出 AssetScout 去互联网寻找并下载全新的公共美术/音频素材包？
规则：
1. 如果已存在素材或描述中不需要特殊的精美素材资源（用纯色块、原生UI实现即可），请回复 NO。
2. 只有明确需要如太空飞船、RPG人物、贴图等特殊素材且当前没有时，回复 YES。

请仅回复 YES 或 NO，不要有任何其他内容。`;

    try {
      const decision = await thinker._callAgent('Architect', '你只负责输出 YES 或 NO', prompt, 0.1);
      if (decision.includes('YES')) {
        console.log('\\x1b[35m🎨 架构师下达获取指令，正在后台并发启动 AssetScout 自动寻宝模块获取素材...\\x1b[0m');
        const scout = new AssetScoutAdapter({ name: 'AssetScout' });
        scout.on('action', (action) => {
          globalBus.emit('agent:action', { agent: scout.name, ...action });
        });
        const scoutTask = {
          id: `scout_${Date.now()}`,
          description: `此项目急需符合风格的素材包：\\n${plan.project?.description || rawContext}`,
          context: { project_root: executeDir }
        };
        scout.execute(scoutTask).then(res => {
          if (res.success) console.log('\\n\\x1b[32m✅ [后台并行] 美术包寻宝圆满完成！已解压就绪。\\x1b[0m\\n');
          else console.log('\\n\\x1b[33m⚠️ [后台并行] 素材获取未全数完成: ' + (res.errors?.[0] || '未知') + '\\x1b[0m\\n');
        }).catch(e => console.log('\\n\\x1b[31m❌ [后台并行] 素材获取严重崩溃: ' + e.message + '\\x1b[0m\\n'));
      } else {
         console.log('\\x1b[32m✅ 架构师评估：当前已有素材或无需外部图片，已跳过寻宝。\\x1b[0m');
      }
    } catch(err) {
      console.log('\\x1b[33m⚠️ 架构师评估失败，为安全起见跳过寻宝。\\x1b[0m');
    }
  }

  console.log('检查 Agent...\n');
  const status = await healthCheck();
  const allReady = Object.values(status).every((v) => v);
  if (!allReady) {
    console.log('\x1b[33m警告: 部分 Agent 不可用，继续执行...\x1b[0m\n');
  }

  const engine = createEngine({
    project_root: executeDir,
  });

  if (globalDaemon) {
    engine.on('task:complete', async (task) => {
      await globalDaemon.getMemory().store(
        'episodic',
        {
          type: 'task_complete',
          taskId: task.id,
          taskName: task.name,
          project: plan.project.name,
        },
        {
          tags: ['task', 'complete', plan.project.name],
          priority: 1,
        },
      );
    });

    engine.on('task:failed', async (task) => {
      await globalDaemon.getMemory().store(
        'episodic',
        {
          type: 'task_failed',
          taskId: task.id,
          taskName: task.name,
          error: task.error,
          project: plan.project.name,
        },
        {
          tags: ['task', 'failed', plan.project.name],
          priority: 2,
        },
      );
    });
  }

  const supervisor = new Supervisor(engine, {
    logger: { logDir: path.join(executeDir, '.ncf', 'logs') },
  });

  await startMonitor();

  // 监听前端控制信令
  globalBus.on('control:pause', () => engine && engine.pause());
  globalBus.on('control:resume', () => engine && engine.resume());

  const forwardEvents = [
    'milestone:start',
    'milestone:done',
    'task:start',
    'task:done',
    'task:error',
    'task:review',
    'task:progress',
    'task:retry_wait',
    'agent:action',
    'engine:paused',
    'engine:resumed',
  ];
  forwardEvents.forEach((e) => engine.on(e, (data) => globalBus.emit(e, data)));

  console.log('='.repeat(50));
  console.log(`开始执行: ${plan.project.name}`);
  console.log(`总任务数: ${plan.tasks.length}`);
  console.log('='.repeat(50));
  console.log();

  const startTime = Date.now();
  const result = await engine.execute(plan);
  const duration = Math.round((Date.now() - startTime) / 1000);

  console.log();
  console.log('='.repeat(50));
  console.log('执行完成');
  console.log('='.repeat(50));
  console.log();
  console.log(`状态: ${result.status}`);
  console.log(`完成: ${result.summary.done}/${result.summary.total} 任务`);
  console.log(`失败: ${result.summary.failed} 任务`);
  console.log(`需人工: ${result.summary.needs_human} 任务`);
  console.log(`评审轮次: ${result.summary.total_review_cycles} 次`);
  console.log(`平均分: ${result.summary.average_score}`);
  console.log(`耗时: ${duration}s`);

  if (globalDaemon) {
    await globalDaemon.getMemory().store(
      'episodic',
      {
        type: 'execution_complete',
        project: plan.project.name,
        status: result.status,
        summary: result.summary,
        duration,
        timestamp: Date.now(),
      },
      {
        tags: ['execution', plan.project.name, 'complete'],
        priority: 2,
      },
    );
  }

  globalBus.emit('execution:done', { result, duration });

  if (result.summary.needs_human > 0) {
    console.log('\n\x1b[33m注意: 部分任务需要人工介入\x1b[0m');
    process.exitCode = 1;
    return;
  }

  if (result.status !== 'success') {
    process.exitCode = 1;
  }
}

function showHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                   NexusCodeForge CLI v2.0.0                    ║
║              NCF - AI 驱动的跨界开发引擎                        ║
╚════════════════════════════════════════════════════════════════╝

📖 用法:
   bun cli.js <command> [options]

🎯 可用命令:
   health (h)          检查 Agent 可用性
   plan (p) <需求>     生成执行计划
   execute (e) <计划>  执行计划文件
  run (r) [需求]      一键生成计划并执行（需求为空时启用 Rainmaker）
   think (t) <问题>    启动 4-Agent 思考与辩论模式
   daemon (d)          查看守护进程状态
   status (s)          查看当前执行状态
   logs (l) [类型]     查看日志 (execution|quality|corrections)
   config (c) [key]    查看/修改配置
   version (v)         显示版本信息
   help (h)            显示帮助信息

⚙️ 选项:
   --dir <路径>        指定工作目录
   --no-daemon         禁用守护进程
   --yes               自动确认执行

📚 示例:
   bun cli.js h
   bun cli.js p "创建一个博客系统"
   bun cli.js r "创建一个博客系统" --dir ./my-project
  bun cli.js r --dir D:\\project
   bun cli.js e plans/plan.json --dir ./my-project
   bun cli.js s --dir ./my-project
   bun cli.js l errors --dir ./my-project
   bun cli.js c token_budget

💡 提示:
   - 使用短命令可以加快输入速度
   - --dir 参数可以避免在主目录工作
   - --yes 可以用于自动化脚本
  - run 只提供 --dir 时会自动触发 Rainmaker 全局巡检与修复规划
`);
}

async function cmdStatus() {
  console.log('\n📊 执行状态概览:\n');

  try {
    const stateFile = path.join(daemonDataDir, 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf-8'));

    console.log('守护进程状态:');
    console.log('  状态:', state.state);
    console.log('  PID:', state.pid);
    console.log('  运行时长:', Math.floor((Date.now() - state.startTime) / 1000) + 's');
    console.log('  已处理任务:', state.stats?.tasksProcessed || 0);
    console.log('  会话总数:', state.stats?.sessionsCreated || 0);
    console.log();
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('守护进程未运行\n');
    } else {
      console.error('读取状态失败:', error.message);
    }
  }

  const ncfDir = path.join(executeDir, '.ncf');
  const checkpointsDir = path.join(ncfDir, 'checkpoints');

  try {
    const checkpoints = await fs.readdir(checkpointsDir);
    const latestCp = checkpoints
      .filter((f) => f.endsWith('.json'))
      .sort()
      .pop();

    if (latestCp) {
      const cpData = JSON.parse(await fs.readFile(path.join(checkpointsDir, latestCp), 'utf-8'));
      console.log('最新检查点:');
      console.log('  ID:', cpData.id);
      console.log('  名称:', cpData.name);
      console.log('  时间:', new Date(cpData.timestamp).toLocaleString());
      console.log('  任务数:', Object.keys(cpData.tasks || {}).length);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('读取检查点失败:', error.message);
    }
  }

  const logsDir = path.join(ncfDir, 'logs');
  if (daemonMode && globalDaemon) {
    const memory = globalDaemon.getMemory();
    if (memory) {
      const memStats = memory.getStats();
      console.log('\n🧠 记忆统计:');
      console.log('  总记忆数:', memStats.totalMemories);
      console.log('  读取次数:', memStats.reads);
      console.log('  写入次数:', memStats.writes);
    }

    const sessions = globalDaemon.getSessions();
    if (sessions) {
      const allSessions = sessions.list();
      console.log('\n📝 最近会话:', allSessions.length);
      for (const s of allSessions.slice(-3)) {
        console.log(`   - ${s.name} [${s.state}]`);
      }
    }
  }

  console.log();
}

async function cmdLogs(type = 'execution') {
  const logsDir = path.join(executeDir, '.ncf', 'logs', type);

  try {
    const files = await fs.readdir(logsDir);
    const logFiles = files.filter((f) => f.endsWith('.log') || f.endsWith('.md'));

    if (logFiles.length === 0) {
      console.log(`\n没有找到 ${type} 类型的日志\n`);
      return;
    }

    const tail = args.includes('--tail') ? parseInt(args[args.indexOf('--tail') + 1]) || 20 : 20;
    const latestFiles = logFiles.sort().slice(-3);

    console.log(`\n📋 ${type} 日志 (最新 ${latestFiles.length} 个文件，显示最后 ${tail} 行):\n`);

    for (const file of latestFiles) {
      const content = await fs.readFile(path.join(logsDir, file), 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      const tailLines = lines.slice(-tail);

      console.log(`--- ${file} ---`);
      console.log(tailLines.join('\n'));
      console.log();
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`\n日志目录不存在: ${logsDir}\n`);
    } else {
      console.error('读取日志失败:', error.message);
    }
  }
}

async function cmdConfig(key, value) {
  console.log('\n⚙️  配置信息:\n');

  const defaultConfig = {
    max_review_cycles: 10,
    task_timeout: 300000,
    max_retries: 2,
    max_concurrent_tasks: 3,
    heartbeat_interval: 30000,
  };

  if (!key) {
    console.log('当前配置:');
    for (const [k, v] of Object.entries(defaultConfig)) {
      console.log(`  ${k}: ${v}`);
    }
    console.log();
    console.log('使用 "bun cli.js config <key>" 查看单个配置');
    console.log('示例: bun cli.js config max_review_cycles');
    return;
  }

  const configKey = key.toLowerCase();

  if (value === undefined) {
    if (defaultConfig[configKey] !== undefined) {
      console.log(`${configKey}: ${defaultConfig[configKey]}`);
    } else {
      console.log(`未找到配置: ${configKey}`);
      console.log('可用配置:');
      for (const k of Object.keys(defaultConfig)) {
        console.log(`  - ${k}`);
      }
    }
  } else {
    console.log(`\n⚠️  修改配置需要重启守护进程`);
    console.log(`当前 ${configKey}: ${defaultConfig[configKey]}`);
    console.log(`建议值: ${value}`);
    console.log(`\n如需永久修改，请编辑 config/defaults.json`);
  }

  console.log();
}

async function cmdThink() {
  const autoYes = args.includes('--yes') || args.includes('-y');
  const actualArgs = args.filter(
    (a) => !a.startsWith('--yes') && a !== '-y' && a !== '--verbose' && a !== '-v',
  );
  const question = actualArgs.slice(1).join(' ');

  if (!question) {
    console.error('\x1b[31m错误: 请提供需要思考的问题\x1b[0m');
    console.log('用法: bun cli.js think "你的问题"');
    process.exit(1);
  }

  // 强制显示内部讨论轨迹 (CLI 展示时要把内部讨论过程印出来)
  const verbose = true;

  console.log('\n' + '='.repeat(50));
  console.log('🤖 进入 4-Agent 多角色思考模式');
  console.log('问题: ' + question);
  console.log('='.repeat(50) + '\n');

  try {
    await startMonitor();
    globalBus.emit('think:start', { question });

    const thinker = new MultiAgentThinker({ verbose });

    const answer = await thinker.think(question, (msg) => {
      globalBus.emit('think:message', { content: msg });
      console.log(`\x1b[36m[Thinker]\x1b[0m ${msg}`);
    });

    globalBus.emit('think:done', { answer });

    console.log('\n' + '='.repeat(50));
    console.log('🌟 最终共识解答 🌟');
    console.log('='.repeat(50) + '\n');
    console.log(answer);
    console.log('\n' + '='.repeat(50) + '\n');
  } catch (err) {
    console.error('\x1b[31m思考过程中发生错误:\x1b[0m', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
