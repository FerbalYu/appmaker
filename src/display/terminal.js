import { stdout } from 'process';

const TASK_ICONS = { pending: '⏳', running: '\x1b[36m🔄\x1b[0m', done: '\x1b[32m✅\x1b[0m', failed: '\x1b[31m❌\x1b[0m' };
const TASK_LABEL = { pending: '待执行', running: '执行中', done: '已完成', failed: '失败' };

const SEP = '─'.repeat(60);

export class TerminalDisplay {
  constructor(bus) {
    this.bus = bus;
    this.tasks = new Map();
    this.milestones = [];
    this.taskDurations = new Map();
    this.logs = [];
    this.startTime = Date.now();
    this.attached = false;
  }

  attach() {
    if (this.attached) return;
    this.attached = true;

    this.bus.on('plan:ready', (data) => this._onPlanReady(data));
    this.bus.on('milestone:start', (data) => this._onMilestoneStart(data));
    this.bus.on('milestone:done', (data) => this._onMilestoneDone(data));
    this.bus.on('task:start', (data) => this._onTaskStart(data));
    this.bus.on('task:done', (data) => this._onTaskDone(data));
    this.bus.on('task:error', (data) => this._onTaskError(data));
    this.bus.on('task:review', (data) => this._log('review', data));
    this.bus.on('task:retry_wait', (data) => this._onRetryWait(data));
    this.bus.on('task:progress', (data) => this._onTaskProgress(data));
    this.bus.on('agent:action', (data) => this._onAgentAction(data));
    this.bus.on('execution:done', (data) => this._onExecutionDone(data));
    this.bus.on('engine:paused', () => this._log('pause', '引擎已暂停'));
    this.bus.on('engine:resumed', () => this._log('resume', '引擎已恢复'));
    this.bus.on('think:start', (data) => this._log('think', `多角色思考开始: ${data.question?.substring(0, 60) || ''}`));
    this.bus.on('think:done', () => this._log('think', '多角色思考完毕'));
    this.bus.on('plan:start', () => this._log('plan', '正在生成执行计划...'));
  }

  _now() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  _elapsed() {
    const s = Math.round((Date.now() - this.startTime) / 1000);
    return `${Math.floor(s / 60)}m${s % 60}s`;
  }

  _onPlanReady({ plan }) {
    if (!plan) return;
    this.tasks.clear();
    this.milestones = plan.milestones || [];
    (plan.tasks || []).forEach((t) => {
      this.tasks.set(t.id, { id: t.id, description: t.description, status: 'pending', milestone: null });
    });
    (plan.milestones || []).forEach((m) => {
      (m.tasks || []).forEach((tid) => {
        const task = this.tasks.get(tid);
        if (task) task.milestone = m.id;
      });
    });
    this._printTaskTable();
    this._log('plan', `计划就绪: ${plan.tasks?.length || 0} 任务 / ${plan.milestones?.length || 0} 里程碑`);
  }

  _onMilestoneStart({ milestone }) {
    if (!milestone) return;
    this._log('milestone', `🚀 里程碑开始: ${milestone.name}`);
  }

  _onMilestoneDone({ milestone }) {
    if (!milestone) return;
    this._log('milestone', `🏁 里程碑完成: ${milestone.name}`);
  }

  _onTaskStart(data) {
    const task = data.task || data;
    const id = task.id;
    if (this.tasks.has(id)) {
      this.tasks.get(id).status = 'running';
      this.taskDurations.set(id, Date.now());
      this._printTaskTable();
      this._log('start', `[${id}] ${task.description || ''} 开始...`);
    }
  }

  _onTaskDone(data) {
    const taskId = data.task ? data.task.id : data.id;
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'done';
      const start = this.taskDurations.get(taskId);
      const dur = start ? `${((Date.now() - start) / 1000).toFixed(1)}s` : '';
      task.duration = dur;
      this._printTaskTable();
      this._log('done', `[${taskId}] ${task.description} 完成${dur ? ' (' + dur + ')' : ''}`);
    }
  }

  _onTaskError(data) {
    const taskId = data.task ? data.task.id : data.id;
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'failed';
      this._printTaskTable();
      this._log('error', `[${taskId}] ${task.description} 失败`);
    }
  }

  _onRetryWait(data) {
    this._log('retry', `等待 ${Math.round((data.delay_ms || 0) / 1000)}s 后重试: ${data.error || ''}`);
  }

  _onTaskProgress(data) {
    const task = data.task || data;
    const id = task.id;
    if (this.tasks.has(id)) {
      this._printTaskTable();
    }
  }

  _onAgentAction(data) {
    if (data.type === 'tool_start') {
      const tool = data.tool || 'unknown';
      const target = data.args?.file_path || data.args?.command || '';
      this._log('tool', `[${data.agent}] ${tool} ${target}`);
    }
  }

  _onExecutionDone({ result, duration }) {
    const s = result?.summary || {};
    const stateLabel = result?.status === 'success' ? '✅ 成功' : '⚠️ 部分失败';
    this._printTaskTable();
    stdout.write(`\n${SEP}\n`);
    stdout.write(`  ${stateLabel}  |  任务: ${s.done || 0}/${s.total || 0}  |  失败: ${s.failed || 0}`);
    if (s.needs_human) stdout.write(`  |  需人工: ${s.needs_human}`);
    stdout.write(`  |  评审: ${s.total_review_cycles || 0} 轮  |  耗时: ${duration || 0}s\n`);
    stdout.write(`${SEP}\n\n`);
  }

  _log(type, message) {
    this.logs.push({ time: this._now(), type, message });
    if (this.logs.length > 500) this.logs.shift();
  }

  _printTaskTable() {
    const tasks = Array.from(this.tasks.values());
    if (tasks.length === 0) return;

    const done = tasks.filter((t) => t.status === 'done').length;
    const failed = tasks.filter((t) => t.status === 'failed').length;
    const running = tasks.filter((t) => t.status === 'running').length;

    let out = `\n${SEP}\n`;
    out += `  Tasks  ${done}/${tasks.length} 完成`;
    if (failed) out += `  ${failed} 失败`;
    if (running) out += `  ${running} 运行中`;
    out += `  |  ${this._elapsed()}\n`;
    out += `${SEP}\n`;

    for (const t of tasks) {
      const icon = TASK_ICONS[t.status] || TASK_ICONS.pending;
      const dur = t.duration ? ` \x1b[90m${t.duration}\x1b[0m` : '';
      out += `  ${icon}  ${t.id}  ${t.description}${dur}\n`;
    }

    out += `${SEP}\n`;
    stdout.write(out);
  }
}
