import { TOOL_CATEGORIES } from '../universal-toolbox.js';

function calculateNextRun() {
  return new Date(Date.now() + 60000).toISOString();
}

export function registerWorkflowTools(toolbox) {
  toolbox._registerTool(
    'enter_plan_mode',
    TOOL_CATEGORIES.WORKFLOW,
    '进入规划模式',
    {
      type: 'object',
      properties: {
        context: { type: 'object' },
      },
    },
    async (args) => {
      toolbox.planMode = true;
      toolbox.planContext = args.context || {};
      return { plan_mode: true, context: toolbox.planContext, entered_at: new Date().toISOString() };
    },
  );

  toolbox._registerTool(
    'exit_plan_mode',
    TOOL_CATEGORIES.WORKFLOW,
    '退出规划模式',
    {
      type: 'object',
      properties: {},
    },
    async () => {
      const context = toolbox.planContext;
      toolbox.planMode = false;
      toolbox.planContext = null;
      return { plan_mode: false, context, exited_at: new Date().toISOString() };
    },
  );

  toolbox._registerTool(
    'enter_worktree',
    TOOL_CATEGORIES.WORKFLOW,
    '创建并进入工作树',
    {
      type: 'object',
      properties: {
        name: { type: 'string' },
        base_branch: { type: 'string' },
      },
      required: ['name'],
    },
    async (args) => {
      const worktreeId = `worktree-${Date.now()}`;
      toolbox.worktrees.set(worktreeId, {
        id: worktreeId,
        name: args.name,
        base_branch: args.base_branch || 'main',
        created_at: new Date().toISOString(),
        active: true,
      });
      return { worktree_id: worktreeId, name: args.name, base_branch: args.base_branch };
    },
  );

  toolbox._registerTool(
    'exit_worktree',
    TOOL_CATEGORIES.WORKFLOW,
    '退出工作树',
    {
      type: 'object',
      properties: {
        worktree_id: { type: 'string' },
      },
      required: ['worktree_id'],
    },
    async (args) => {
      const worktree = toolbox.worktrees.get(args.worktree_id);
      if (!worktree) {
        return { error: `Worktree not found: ${args.worktree_id}` };
      }
      worktree.active = false;
      worktree.exited_at = new Date().toISOString();
      return { worktree_id: args.worktree_id, exited: true };
    },
  );

  toolbox._registerTool(
    'todo_write',
    TOOL_CATEGORIES.WORKFLOW,
    '写入任务清单',
    {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['in_progress', 'completed', 'pending'] },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
          },
        },
      },
      required: ['todos'],
    },
    async (args) => {
      const todoItems = (args.todos || []).map((t, idx) => ({
        id: `todo-${Date.now()}-${idx}`,
        content: t.content || '',
        status: t.status || 'pending',
        priority: t.priority || 'medium',
        created_at: new Date().toISOString(),
      }));
      return { todos: todoItems, count: todoItems.length, written_at: new Date().toISOString() };
    },
  );

  toolbox._registerTool(
    'cron_schedule',
    TOOL_CATEGORIES.WORKFLOW,
    '创建定时任务',
    {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Cron 表达式，如 "*/5 * * * *"' },
        task: { type: 'string' },
        enabled: { type: 'boolean', default: true },
      },
      required: ['expression', 'task'],
    },
    async (args) => {
      const jobId = `cron-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      toolbox.cronJobs.set(jobId, {
        id: jobId,
        expression: args.expression,
        task: args.task,
        enabled: args.enabled !== false,
        created_at: new Date().toISOString(),
        last_run: null,
        next_run: calculateNextRun(),
      });
      return { job_id: jobId, expression: args.expression, enabled: args.enabled };
    },
  );

  toolbox._registerTool(
    'cron_list',
    TOOL_CATEGORIES.WORKFLOW,
    '列出定时任务',
    {
      type: 'object',
      properties: {},
    },
    async () => {
      const jobs = Array.from(toolbox.cronJobs.values());
      return { jobs, count: jobs.length };
    },
  );

  toolbox._registerTool(
    'cron_delete',
    TOOL_CATEGORIES.WORKFLOW,
    '删除定时任务',
    {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
      },
      required: ['job_id'],
    },
    async (args) => {
      if (!toolbox.cronJobs.has(args.job_id)) {
        return { error: `Cron job not found: ${args.job_id}` };
      }
      toolbox.cronJobs.delete(args.job_id);
      return { job_id: args.job_id, deleted: true };
    },
  );
}
