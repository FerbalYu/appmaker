import { TOOL_CATEGORIES } from '../universal-toolbox.js';

export function registerAgentTools(toolbox) {
  toolbox._registerTool(
    'send_message',
    TOOL_CATEGORIES.AGENT,
    '向代理发送消息',
    {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        message: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], default: 'normal' },
      },
      required: ['agent_id', 'message'],
    },
    async (args) => {
      return {
        agent_id: args.agent_id,
        message: args.message,
        sent_at: new Date().toISOString(),
        status: 'delivered',
      };
    },
  );

  toolbox._registerTool(
    'team_create',
    TOOL_CATEGORIES.AGENT,
    '创建代理团队',
    {
      type: 'object',
      properties: {
        name: { type: 'string' },
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              role: { type: 'string' },
              capabilities: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      required: ['name'],
    },
    async (args) => {
      const teamId = `team-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const team = {
        id: teamId,
        name: args.name,
        agents: args.agents || [],
        created_at: new Date().toISOString(),
        status: 'active',
      };
      toolbox.teams.set(teamId, team);
      return { team_id: teamId, name: args.name, agents_count: team.agents.length };
    },
  );

  toolbox._registerTool(
    'team_delete',
    TOOL_CATEGORIES.AGENT,
    '删除代理团队',
    {
      type: 'object',
      properties: {
        team_id: { type: 'string' },
      },
      required: ['team_id'],
    },
    async (args) => {
      if (!toolbox.teams.has(args.team_id)) {
        return { error: `Team not found: ${args.team_id}` };
      }
      toolbox.teams.delete(args.team_id);
      return { team_id: args.team_id, deleted: true };
    },
  );

  toolbox._registerTool(
    'team_list',
    TOOL_CATEGORIES.AGENT,
    '列出所有代理团队',
    {
      type: 'object',
      properties: {},
    },
    async () => {
      const teams = Array.from(toolbox.teams.values());
      return { teams, count: teams.length };
    },
  );

  toolbox._registerTool(
    'agent_status',
    TOOL_CATEGORIES.AGENT,
    '获取代理状态',
    {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
      },
      required: ['agent_id'],
    },
    async (args) => {
      const agent = toolbox.subagents.get(args.agent_id) || { status: 'unknown' };
      return { agent_id: args.agent_id, status: agent.status || 'unknown' };
    },
  );
}
