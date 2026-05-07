import { promises as fs } from 'fs';
import { exec } from 'child_process';
import { TOOL_CATEGORIES } from '../universal-toolbox.js';

export function registerInteractiveTools(toolbox) {
  toolbox._registerTool(
    'ask_user_question',
    TOOL_CATEGORIES.INTERACTIVE,
    '向用户提问',
    {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
        multi_select: { type: 'boolean', default: false },
      },
      required: ['question'],
    },
    async (args) => {
      return {
        question: args.question,
        options: args.options || [],
        multi_select: args.multi_select || false,
        asked_at: new Date().toISOString(),
        status: 'awaiting_response',
      };
    },
  );

  toolbox._registerTool(
    'notebook_edit',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '编辑 Jupyter Notebook',
    {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        cell_index: { type: 'number' },
        content: { type: 'string' },
        cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'] },
      },
      required: ['file_path', 'cell_index', 'content'],
    },
    async (args) => {
      const fullPath = toolbox._resolvePathInWorkspace(args.file_path, 'file_path');
      let notebook;
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        notebook = JSON.parse(content);
      } catch {
        notebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
      }

      if (!notebook.cells) notebook.cells = [];

      const cell = {
        cell_type: args.cell_type || 'code',
        metadata: {},
        source: args.content,
      };

      if (args.cell_index >= notebook.cells.length) {
        notebook.cells.push(cell);
      } else {
        notebook.cells[args.cell_index] = cell;
      }

      await fs.writeFile(fullPath, JSON.stringify(notebook, null, 2), 'utf-8');
      return { file_path: args.file_path, cell_index: args.cell_index, edited: true };
    },
  );

  toolbox._registerTool(
    'powershell_execute',
    TOOL_CATEGORIES.BASH,
    '执行 PowerShell 命令',
    {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout: { type: 'number', default: 30000 },
      },
      required: ['command'],
    },
    async (args) => {
      return new Promise((resolve) => {
        const cwd = toolbox._resolveCwdInWorkspace(args.cwd);
        const psCommand = args.command.includes('powershell')
          ? args.command
          : `powershell -Command "${args.command.replace(/"/g, '\\"')}"`;
        exec(
          psCommand,
          { cwd, timeout: args.timeout || toolbox.config.timeout },
          (error, stdout, stderr) => {
            resolve({
              command: args.command,
              stdout: stdout.substring(0, toolbox.config.max_output_size),
              stderr: stderr.substring(0, toolbox.config.max_output_size),
              exit_code: error?.code || 0,
              success: !error,
            });
          },
        );
      });
    },
  );

  toolbox._registerTool(
    'web_fetch',
    TOOL_CATEGORIES.NETWORK,
    '获取网页内容',
    {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
    async (args) => {
      try {
        const response = await fetch(args.url, {
          headers: { 'User-Agent': 'NexusCodeForge/1.0' },
        });
        const text = await response.text();
        return {
          url: args.url,
          status: response.status,
          content: text.substring(0, toolbox.config.max_output_size),
          content_type: response.headers.get('content-type'),
        };
      } catch (err) {
        return { url: args.url, error: err.message };
      }
    },
  );

  toolbox._registerTool(
    'web_search',
    TOOL_CATEGORIES.NETWORK,
    '网络搜索',
    {
      type: 'object',
      properties: {
        query: { type: 'string' },
        engine: { type: 'string', default: 'duckduckgo' },
      },
      required: ['query'],
    },
    async (args) => {
      return {
        query: args.query,
        engine: args.engine,
        results: [],
        searched_at: new Date().toISOString(),
        status: 'simulated',
      };
    },
  );

  toolbox._registerTool(
    'tool_search',
    TOOL_CATEGORIES.UTILITY,
    '搜索可用工具',
    {
      type: 'object',
      properties: {
        query: { type: 'string' },
        category: { type: 'string' },
      },
      required: ['query'],
    },
    async (args) => {
      const allTools = toolbox.getToolsMetadata();
      const query = args.query.toLowerCase();
      const results = allTools.filter((t) => {
        const matchQuery =
          t.name.toLowerCase().includes(query) || t.description.toLowerCase().includes(query);
        const matchCategory = !args.category || t.category === args.category;
        return matchQuery && matchCategory;
      });
      return { query: args.query, results, count: results.length };
    },
  );
}
