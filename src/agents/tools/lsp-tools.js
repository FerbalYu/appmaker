import { TOOL_CATEGORIES } from '../universal-toolbox.js';

async function lspRequest(toolbox, server, method, params) {
  const client = toolbox.lspClients.get(server);
  if (!client) {
    return { error: `LSP server not initialized: ${server}` };
  }
  try {
    return await client.sendRequest(method, params);
  } catch (err) {
    return { error: err.message };
  }
}

export function registerLspTools(toolbox) {
  toolbox._registerTool(
    'lsp_hover',
    TOOL_CATEGORIES.LSP,
    'LSP 悬停信息查询',
    {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        line: { type: 'number' },
        character: { type: 'number' },
        language_server: { type: 'string', default: 'typescript' },
      },
      required: ['file_path', 'line', 'character'],
    },
    async (args) => {
      return lspRequest(toolbox, args.language_server, 'textDocument/hover', {
        textDocument: {
          uri: `file://${toolbox._resolvePathInWorkspace(args.file_path, 'file_path')}`,
        },
        position: { line: args.line, character: args.character },
      });
    },
  );

  toolbox._registerTool(
    'lsp_definition',
    TOOL_CATEGORIES.LSP,
    'LSP 跳转定义',
    {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        line: { type: 'number' },
        character: { type: 'number' },
        language_server: { type: 'string', default: 'typescript' },
      },
      required: ['file_path', 'line', 'character'],
    },
    async (args) => {
      return lspRequest(toolbox, args.language_server, 'textDocument/definition', {
        textDocument: {
          uri: `file://${toolbox._resolvePathInWorkspace(args.file_path, 'file_path')}`,
        },
        position: { line: args.line, character: args.character },
      });
    },
  );

  toolbox._registerTool(
    'lsp_diagnostics',
    TOOL_CATEGORIES.LSP,
    'LSP 诊断信息',
    {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        language_server: { type: 'string', default: 'typescript' },
      },
      required: ['file_path'],
    },
    async (args) => {
      return lspRequest(toolbox, args.language_server, 'textDocument/diagnostic', {
        textDocument: {
          uri: `file://${toolbox._resolvePathInWorkspace(args.file_path, 'file_path')}`,
        },
      });
    },
  );

  toolbox._registerTool(
    'lsp_initialize',
    TOOL_CATEGORIES.LSP,
    '初始化 LSP 服务器',
    {
      type: 'object',
      properties: {
        language: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
      },
      required: ['language', 'command'],
    },
    async (args) => {
      try {
        const { StdioClientTransport } =
          await import('@modelcontextprotocol/sdk/client/stdio.js');
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

        const transport = new StdioClientTransport({
          command: args.command,
          args: args.args || [],
        });
        const client = new Client(
          {
            name: `NexusCodeForge-LSP-${args.language}`,
            version: '1.0.0',
          },
          {},
        );

        await client.connect(transport);
        toolbox.lspClients.set(args.language, client);
        return { language: args.language, status: 'initialized' };
      } catch (err) {
        return { language: args.language, status: 'failed', error: err.message };
      }
    },
  );
}
