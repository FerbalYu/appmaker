#!/usr/bin/env bun
/**
 * appMaker CLI
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
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { exec } from 'child_process';

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

const mainDir = path.resolve(__dirname);
if (executeDir === mainDir || executeDir.startsWith(mainDir + path.sep)) {
  console.error('\x1b[31m错误: 禁止在主程序文件夹下工作！\x1b[0m');
  console.error(`请使用 --dir 参数指定工作目录，例如:`);
  console.error(`  bun cli.js run "需求描述" --dir ./my-project`);
  console.error(`  bun cli.js run "需求描述" --dir D:\\projects\\my-app`);
  process.exit(1);
}

daemonDataDir = path.join(executeDir, '.daemon');

process.on('unhandledRejection', (error) => {
  console.error('\x1b[31mUnhandled Rejection:\x1b[0m', error?.message || error);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('\x1b[31mUnhandled Exception:\x1b[0m', error?.message || error);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});

let globalDaemon = null;

async function main() {
  try {
    console.log('='.repeat(50));
    console.log('appMaker - AI 驱动的 APP 开发系统');
    console.log('claude-code 编程 + opencode 毒舌点评');
    console.log('工作目录: ' + executeDir);
    console.log('='.repeat(50));
    console.log();

    if (daemonMode) {
      console.log('🔮 初始化持久守护进程...\n');
      globalDaemon = await createDaemon({
        dataDir: daemonDataDir,
        heartbeatInterval: 30000,
        autoSaveInterval: 60000,
        recoveryEnabled: true
      });

      globalDaemon.on('heartbeat', (health) => {
        if (process.env.DEBUG) {
          console.log(`💓 心跳 [${new Date().toLocaleTimeString()}]`, {
            state: health.state,
            memory: Math.round(health.memory.heapUsed / 1024 / 1024) + 'MB'
          });
        }
      });

      await globalDaemon.start();
      console.log(`✅ 守护进程已启动 (PID: ${globalDaemon.pid})\n`);
    }

    switch (command) {
      case 'health':
      case '--health':
        await cmdHealth();
        break;

      case 'plan':
      case '--plan':
        await cmdPlan(args[1]);
        break;

      case 'execute':
      case '--execute':
        await cmdExecute(args[1]);
        break;

      case 'run':
      case '--run':
        await cmdRun(args[1]);
        break;

      case 'daemon':
        await cmdDaemonStatus();
        break;

      default:
        showHelp();
    }

    if (globalDaemon) {
      await globalDaemon.saveState();
      console.log('\n🔮 守护进程继续在后台运行...');
      console.log(`   数据目录: ${daemonDataDir}`);
      console.log(`   查看状态: bun cli.js daemon --dir "${executeDir}"`);
    }

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

  const allReady = Object.values(status).every(v => v);
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
    await globalDaemon.getMemory().store('semantic', {
      type: 'plan_request',
      requirement,
      timestamp: Date.now()
    }, {
      tags: ['planning', 'intent']
    });
  }

  try {
    const planner = new Planner({ project_root: executeDir });
    const plan = await planner.plan(requirement);

    const filename = `plan_${Date.now()}.json`;
    const plansDir = path.join(__dirname, 'plans');
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
      const planner = new Planner({ project_root: executeDir });
      plan = await planner.plan(input);

      const filename = `plan_${Date.now()}.json`;
      const plansDir = path.join(__dirname, 'plans');
      await planner.savePlan(plan, filename, plansDir);
    } catch (error) {
      console.error('\x1b[31mFailed to generate plan:\x1b[0m', error.message);
      if (process.env.DEBUG) console.error(error.stack);
      process.exit(1);
    }
  }

  await executePlan(plan);
}

async function cmdRun(requirement) {
  const autoYes = args.includes('--yes') || args.includes('-y');
  const actualArgs = args.filter(a => !a.startsWith('--yes') && a !== '-y');
  requirement = actualArgs.slice(1).join(' ');

  if (!requirement) {
    console.error('\x1b[31m错误: 请提供需求描述\x1b[0m');
    console.log('用法: bun cli.js run "做一个博客系统" [--yes] [--no-daemon]');
    process.exit(1);
  }

  console.log('='.repeat(50));
  console.log('步骤 1: 生成执行计划');
  console.log('='.repeat(50));
  console.log();

  let plan;
  try {
    const planner = new Planner({ project_root: executeDir });
    plan = await planner.plan(requirement);

    const filename = `plan_${Date.now()}.json`;
    const plansDir = path.join(__dirname, 'plans');
    await planner.savePlan(plan, filename, plansDir);

    if (globalDaemon) {
      await globalDaemon.getMemory().store('semantic', {
        type: 'execution_plan',
        project: plan.project,
        taskCount: plan.tasks.length,
        milestoneCount: plan.milestones.length,
        filename
      }, {
        tags: ['planning', 'execution', plan.project.name]
      });
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
    const answer = await new Promise(resolve => rl.question('确认执行? (y/n): ', resolve));
    rl.close();
    confirmed = answer.toLowerCase() === 'y';
  }

  if (!confirmed) {
    console.log('已取消');
    process.exit(0);
  }

  console.log();
  console.log('='.repeat(50));
  console.log('步骤 2: 执行计划');
  console.log('='.repeat(50));
  console.log();

  await executePlan(plan);
}

async function executePlan(plan) {
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
        plan: plan.project
      }
    });

    await globalDaemon.getMemory().store('episodic', {
      type: 'execution_start',
      project: plan.project.name,
      sessionId: session.id,
      taskCount: plan.tasks.length
    }, {
      tags: ['execution', plan.project.name, 'start']
    });
  }

  console.log('开始执行计划...\n');
  console.log('检查 Agent...\n');
  const status = await healthCheck();
  const allReady = Object.values(status).every(v => v);
  if (!allReady) {
    console.log('\x1b[33m警告: 部分 Agent 不可用，继续执行...\x1b[0m\n');
  }

  const engine = createEngine({
    project_root: executeDir,
    max_review_cycles: 3
  });

  if (globalDaemon) {
    engine.on('task:complete', async (task) => {
      await globalDaemon.getMemory().store('episodic', {
        type: 'task_complete',
        taskId: task.id,
        taskName: task.name,
        project: plan.project.name
      }, {
        tags: ['task', 'complete', plan.project.name],
        priority: 1
      });
    });

    engine.on('task:failed', async (task) => {
      await globalDaemon.getMemory().store('episodic', {
        type: 'task_failed',
        taskId: task.id,
        taskName: task.name,
        error: task.error,
        project: plan.project.name
      }, {
        tags: ['task', 'failed', plan.project.name],
        priority: 2
      });
    });
  }

  const supervisor = new Supervisor(engine, {
    logger: { logDir: path.join(executeDir, '.appmaker', 'logs') }
  });

  const monitor = new ProgressMonitor(engine, 8088);
  const monitorUrl = await monitor.start();
  console.log(`\x1b[36m🚀 已开启浮动进度看板: ${monitorUrl}\x1b[0m\n`);

  if (process.platform === 'win32') exec(`start ${monitorUrl}`);
  else if (process.platform === 'darwin') exec(`open ${monitorUrl}`);
  else exec(`xdg-open ${monitorUrl}`);

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
    await globalDaemon.getMemory().store('episodic', {
      type: 'execution_complete',
      project: plan.project.name,
      status: result.status,
      summary: result.summary,
      duration,
      timestamp: Date.now()
    }, {
      tags: ['execution', plan.project.name, 'complete'],
      priority: 2
    });
  }

  if (result.summary.needs_human > 0) {
    console.log('\n\x1b[33m注意: 部分任务需要人工介入\x1b[0m');
    process.exit(1);
  }

  if (result.status !== 'success') {
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
用法: bun cli.js <command> [参数]

命令:
  health                 检查 Agent 可用性
  plan "需求描述"       生成执行计划（保存到 plans/）
  execute <plan.json>   执行计划文件
  run "需求描述"        生成计划并自动执行（推荐）
  daemon                 查看守护进程状态

选项:
  --dir <路径>           指定工作目录（默认: 当前目录）
  --no-daemon            禁用守护进程模式
  --yes, -y              自动确认执行

示例:
  bun cli.js health
  bun cli.js plan "做一个博客系统，支持文章和评论"
  bun cli.js run "做一个博客系统"
  bun cli.js run "做一个博客系统" --yes
  bun cli.js daemon --dir ./my-project

守护进程:
  执行任务时会自动启动守护进程，任务信息会被记录到记忆中。
  守护进程会在后台持续运行，记录项目的学习进度和执行历史。
  使用 "bun cli.js daemon" 可查看守护进程状态。
`);
}

main();
