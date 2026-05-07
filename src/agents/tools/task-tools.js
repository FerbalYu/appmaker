import { TOOL_CATEGORIES } from '../universal-toolbox.js';

export function registerTaskTools(toolbox) {
  toolbox._registerTool(
    'task_create',
    TOOL_CATEGORIES.TASK,
    '创建新任务',
    {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
    async (args) => {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const task = {
        id: taskId,
        title: args.title,
        description: args.description || '',
        priority: args.priority || 'medium',
        tags: args.tags || [],
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      toolbox.tasks.set(taskId, task);
      return { task_id: taskId, ...task };
    },
  );

  toolbox._registerTool(
    'task_get',
    TOOL_CATEGORIES.TASK,
    '获取任务详情',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
    async (args) => {
      const task = toolbox.tasks.get(args.task_id);
      if (!task) {
        return { error: `Task not found: ${args.task_id}` };
      }
      return { task: { ...task } };
    },
  );

  toolbox._registerTool(
    'task_list',
    TOOL_CATEGORIES.TASK,
    '列出所有任务',
    {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'all'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    async (args) => {
      let tasks = Array.from(toolbox.tasks.values());
      if (args.status && args.status !== 'all') {
        tasks = tasks.filter((t) => t.status === args.status);
      }
      if (args.tags && args.tags.length > 0) {
        tasks = tasks.filter((t) => args.tags.some((tag) => t.tags.includes(tag)));
      }
      return { tasks, count: tasks.length };
    },
  );

  toolbox._registerTool(
    'task_update',
    TOOL_CATEGORIES.TASK,
    '更新任务状态',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['task_id'],
    },
    async (args) => {
      const task = toolbox.tasks.get(args.task_id);
      if (!task) {
        return { error: `Task not found: ${args.task_id}` };
      }
      if (args.status) task.status = args.status;
      if (args.title) task.title = args.title;
      if (args.description) task.description = args.description;
      task.updated_at = new Date().toISOString();
      return { task_id: args.task_id, updated: true, task: { ...task } };
    },
  );

  toolbox._registerTool(
    'task_stop',
    TOOL_CATEGORIES.TASK,
    '停止任务',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
    async (args) => {
      const task = toolbox.tasks.get(args.task_id);
      if (!task) {
        return { error: `Task not found: ${args.task_id}` };
      }
      task.status = 'cancelled';
      task.stopped_at = new Date().toISOString();
      return { task_id: args.task_id, stopped: true };
    },
  );

  toolbox._registerTool(
    'task_output',
    TOOL_CATEGORIES.TASK,
    '获取任务输出',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
    async (args) => {
      const task = toolbox.tasks.get(args.task_id);
      if (!task) {
        return { error: `Task not found: ${args.task_id}` };
      }
      return { task_id: args.task_id, output: task.output || null, status: task.status };
    },
  );

  toolbox._registerTool(
    'task_delete',
    TOOL_CATEGORIES.TASK,
    '删除任务',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
    async (args) => {
      if (!toolbox.tasks.has(args.task_id)) {
        return { error: `Task not found: ${args.task_id}` };
      }
      toolbox.tasks.delete(args.task_id);
      return { task_id: args.task_id, deleted: true };
    },
  );
}
