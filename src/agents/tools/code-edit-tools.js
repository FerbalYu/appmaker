import { promises as fs } from 'fs';
import { TOOL_CATEGORIES } from '../universal-toolbox.js';

export function registerCodeEditTools(toolbox) {
  toolbox._registerTool(
    'edit_file',
    TOOL_CATEGORIES.CODE_EDIT,
    '编辑文件（整体替换）',
    {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
    async (args) => {
      return toolbox.execute('write_file', { file_path: args.file_path, content: args.content });
    },
  );

  toolbox._registerTool(
    'insert_content',
    TOOL_CATEGORIES.CODE_EDIT,
    '在文件指定位置插入内容',
    {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
        after_line: { type: 'number' },
      },
      required: ['file_path', 'content', 'after_line'],
    },
    async (args) => {
      const fullPath = toolbox._resolvePathInWorkspace(args.file_path, 'file_path');
      const lines = (await fs.readFile(fullPath, 'utf-8')).split('\n');
      lines.splice(args.after_line, 0, args.content);
      await fs.writeFile(fullPath, lines.join('\n'), 'utf-8');
      return { file_path: args.file_path, inserted_at_line: args.after_line };
    },
  );

  toolbox._registerTool(
    'remove_content',
    TOOL_CATEGORIES.CODE_EDIT,
    '删除文件指定行',
    {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        start_line: { type: 'number' },
        end_line: { type: 'number' },
      },
      required: ['file_path', 'start_line', 'end_line'],
    },
    async (args) => {
      const fullPath = toolbox._resolvePathInWorkspace(args.file_path, 'file_path');
      const lines = (await fs.readFile(fullPath, 'utf-8')).split('\n');
      lines.splice(args.start_line - 1, args.end_line - args.start_line + 1);
      await fs.writeFile(fullPath, lines.join('\n'), 'utf-8');
      return { file_path: args.file_path, removed_lines: `${args.start_line}-${args.end_line}` };
    },
  );

  toolbox._registerTool(
    'replace_content',
    TOOL_CATEGORIES.CODE_EDIT,
    '替换文件中的文本',
    {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        search: { type: 'string' },
        replace: { type: 'string' },
        replace_all: { type: 'boolean', default: false },
      },
      required: ['file_path', 'search', 'replace'],
    },
    async (args) => {
      const fullPath = toolbox._resolvePathInWorkspace(args.file_path, 'file_path');
      let content = await fs.readFile(fullPath, 'utf-8');
      const regex = new RegExp(args.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      const matches = content.match(regex);
      const count = matches ? matches.length : 0;
      content = content.replace(regex, args.replace);
      await fs.writeFile(fullPath, content, 'utf-8');
      return { file_path: args.file_path, replaced_count: count };
    },
  );
}
