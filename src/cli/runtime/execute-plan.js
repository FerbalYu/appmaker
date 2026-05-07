import { createEngine, healthCheck } from '../../agents/index.js';
import { Supervisor } from '../../supervisor.js';
import { promises as fs } from 'fs';
import path from 'path';

export async function executePlan({
  plan,
  rawContext = '',
  executeDir,
  globalDaemon,
  globalBus,
}) {
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
