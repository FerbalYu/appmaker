import { TOOL_CATEGORIES } from '../universal-toolbox.js';

export function registerSubagentTools(toolbox) {
  toolbox._registerTool(
    'spawn_subagent',
    TOOL_CATEGORIES.SUBAGENT,
    '生成并启动子代理',
    {
      type: 'object',
      properties: {
        name: { type: 'string' },
        role: { type: 'string' },
        task: { type: 'string' },
        capabilities: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'role', 'task'],
    },
    async (args) => {
      const agentId = `subagent-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const subagent = {
        id: agentId,
        name: args.name,
        role: args.role,
        task: args.task,
        capabilities: args.capabilities || [],
        status: 'running',
        created_at: new Date().toISOString(),
      };
      toolbox.subagents.set(agentId, subagent);
      return { subagent_id: agentId, ...subagent };
    },
  );

  toolbox._registerTool(
    'delegate_task',
    TOOL_CATEGORIES.SUBAGENT,
    '委托任务给子代理',
    {
      type: 'object',
      properties: {
        subagent_id: { type: 'string' },
        task: { type: 'string' },
        context: { type: 'object' },
      },
      required: ['subagent_id', 'task'],
    },
    async (args) => {
      const subagent = toolbox.subagents.get(args.subagent_id);
      if (!subagent) {
        return { error: `Subagent not found: ${args.subagent_id}` };
      }
      return {
        subagent_id: args.subagent_id,
        delegated_task: args.task,
        context: args.context,
        status: 'executed',
      };
    },
  );

  toolbox._registerTool(
    'list_subagents',
    TOOL_CATEGORIES.SUBAGENT,
    '列出所有子代理',
    {
      type: 'object',
      properties: {},
    },
    async () => {
      const agents = [];
      for (const [id, agent] of toolbox.subagents) {
        agents.push(agent);
      }
      return { subagents: agents, count: agents.length };
    },
  );

  toolbox._registerTool(
    'terminate_subagent',
    TOOL_CATEGORIES.SUBAGENT,
    '终止子代理',
    {
      type: 'object',
      properties: {
        subagent_id: { type: 'string' },
      },
      required: ['subagent_id'],
    },
    async (args) => {
      const subagent = toolbox.subagents.get(args.subagent_id);
      if (!subagent) {
        return { error: `Subagent not found: ${args.subagent_id}` };
      }
      subagent.status = 'terminated';
      subagent.terminated_at = new Date().toISOString();
      return { subagent_id: args.subagent_id, status: 'terminated' };
    },
  );
}
