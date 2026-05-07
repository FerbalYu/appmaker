import { TOOL_CATEGORIES } from '../universal-toolbox.js';

export function registerMcpTools(toolbox) {
  toolbox._registerTool(
    'mcp_list_tools',
    TOOL_CATEGORIES.MCP,
    '列出 MCP 服务器上的工具',
    {
      type: 'object',
      properties: {
        server_name: { type: 'string' },
      },
    },
    async (args) => {
      const client = toolbox.lspClients.get(args.server_name || 'default');
      if (!client) {
        return { error: `MCP server not found: ${args.server_name || 'default'}` };
      }
      try {
        const tools = await client.listTools();
        return {
          server: args.server_name,
          tools: tools.tools || [],
          count: tools.tools?.length || 0,
        };
      } catch (err) {
        return { error: err.message };
      }
    },
  );

  toolbox._registerTool(
    'mcp_read_resource',
    TOOL_CATEGORIES.MCP,
    '读取 MCP 资源',
    {
      type: 'object',
      properties: {
        server_name: { type: 'string' },
        uri: { type: 'string' },
      },
      required: ['uri'],
    },
    async (args) => {
      const client = toolbox.lspClients.get(args.server_name || 'default');
      if (!client) {
        return { error: `MCP server not found: ${args.server_name || 'default'}` };
      }
      try {
        const resource = await client.readResource({ uri: args.uri });
        return { uri: args.uri, contents: resource.contents || [] };
      } catch (err) {
        return { error: err.message };
      }
    },
  );

  toolbox._registerTool(
    'mcp_call_tool',
    TOOL_CATEGORIES.MCP,
    '调用 MCP 工具',
    {
      type: 'object',
      properties: {
        server_name: { type: 'string' },
        tool_name: { type: 'string' },
        arguments: { type: 'object' },
      },
      required: ['tool_name'],
    },
    async (args) => {
      const client = toolbox.lspClients.get(args.server_name || 'default');
      if (!client) {
        return { error: `MCP server not found: ${args.server_name || 'default'}` };
      }
      try {
        const result = await client.callTool({
          name: args.tool_name,
          arguments: args.arguments || {},
        });
        return { tool: args.tool_name, result };
      } catch (err) {
        return { error: err.message };
      }
    },
  );

  toolbox._registerTool(
    'mcp_list_servers',
    TOOL_CATEGORIES.MCP,
    '列出所有 MCP 服务器',
    {
      type: 'object',
      properties: {},
    },
    async () => {
      const servers = Array.from(toolbox.lspClients.entries()).map(([name, client]) => ({
        name,
        connected: true,
      }));
      return { servers, count: servers.length };
    },
  );
}
