import { promises as fs } from 'fs';
import path from 'path';
import { TOOL_CATEGORIES } from '../universal-toolbox.js';

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function searchInDir(dir, pattern, filePattern, caseSensitive, results, workspaceRoot) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await searchInDir(fullPath, pattern, filePattern, caseSensitive, results, workspaceRoot);
      } else if (entry.isFile()) {
        if (filePattern !== '*' && !entry.name.includes(filePattern)) continue;
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();
          const searchContent = caseSensitive ? content : content.toLowerCase();
          if (searchContent.includes(searchPattern)) {
            const relativePath = path.relative(workspaceRoot, fullPath);
            results.push({ file: relativePath, path: fullPath });
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // skip inaccessible directories
  }
}

export function registerFileTools(toolbox) {
  toolbox._registerTool(
    'read_file',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '读取单个文件内容',
    {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径（相对于工作区）' },
      },
      required: ['file_path'],
    },
    async (args) => {
      const fullPath = toolbox._resolvePathInWorkspace(args.file_path, 'file_path');
      const content = await fs.readFile(fullPath, 'utf-8');
      return { file_path: args.file_path, content, size: content.length };
    },
  );

  toolbox._registerTool(
    'read_multiple_files',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '批量读取多个文件',
    {
      type: 'object',
      properties: {
        file_paths: { type: 'array', items: { type: 'string' }, description: '文件路径数组' },
      },
      required: ['file_paths'],
    },
    async (args) => {
      const results = [];
      for (const fp of args.file_paths) {
        const fullPath = toolbox._resolvePathInWorkspace(fp, 'file_paths');
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          results.push({ file_path: fp, content, size: content.length, success: true });
        } catch (e) {
          results.push({ file_path: fp, error: e.message, success: false });
        }
      }
      return { files: results };
    },
  );

  toolbox._registerTool(
    'write_file',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '写入文件内容',
    {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
        append: { type: 'boolean', default: false },
      },
      required: ['file_path', 'content'],
    },
    async (args) => {
      const fullPath = toolbox._resolvePathInWorkspace(args.file_path, 'file_path');
      const dir = path.dirname(fullPath);
      await fs.mkdir(dir, { recursive: true });
      if (args.append) {
        await fs.appendFile(fullPath, args.content, 'utf-8');
      } else {
        await fs.writeFile(fullPath, args.content, 'utf-8');
      }
      return { file_path: args.file_path, written: true };
    },
  );

  toolbox._registerTool(
    'create_directory',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '创建目录',
    {
      type: 'object',
      properties: {
        dir_path: { type: 'string' },
        recursive: { type: 'boolean', default: true },
      },
      required: ['dir_path'],
    },
    async (args) => {
      const fullPath = toolbox._resolvePathInWorkspace(args.dir_path, 'dir_path');
      await fs.mkdir(fullPath, { recursive: args.recursive !== false });
      return { dir_path: args.dir_path, created: true };
    },
  );

  toolbox._registerTool(
    'delete_file',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '删除文件或目录',
    {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean', default: false },
      },
      required: ['path'],
    },
    async (args) => {
      const fullPath = toolbox._resolvePathInWorkspace(args.path, 'path');
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        await fs.rm(fullPath, { recursive: args.recursive });
      } else {
        await fs.unlink(fullPath);
      }
      return { path: args.path, deleted: true };
    },
  );

  toolbox._registerTool(
    'move_file',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '移动文件或目录',
    {
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
      },
      required: ['source', 'destination'],
    },
    async (args) => {
      const src = toolbox._resolvePathInWorkspace(args.source, 'source');
      const dest = toolbox._resolvePathInWorkspace(args.destination, 'destination');
      await fs.rename(src, dest);
      return { source: args.source, destination: args.destination, moved: true };
    },
  );

  toolbox._registerTool(
    'copy_file',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '复制文件或目录',
    {
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
      },
      required: ['source', 'destination'],
    },
    async (args) => {
      const src = toolbox._resolvePathInWorkspace(args.source, 'source');
      const dest = toolbox._resolvePathInWorkspace(args.destination, 'destination');
      const stat = await fs.stat(src);
      if (stat.isDirectory()) {
        await copyDir(src, dest);
      } else {
        await fs.copyFile(src, dest);
      }
      return { source: args.source, destination: args.destination, copied: true };
    },
  );

  toolbox._registerTool(
    'list_directory',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '列出目录内容',
    {
      type: 'object',
      properties: {
        dir_path: { type: 'string', default: '.' },
        include_hidden: { type: 'boolean', default: false },
      },
    },
    async (args) => {
      const fullPath = toolbox._resolvePathInWorkspace(args.dir_path || '.', 'dir_path');
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const items = entries
        .filter((e) => args.include_hidden || !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          isDirectory: e.isDirectory(),
        }));
      return { dir_path: args.dir_path || '.', items, count: items.length };
    },
  );

  toolbox._registerTool(
    'file_exists',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '检查文件或目录是否存在',
    {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    async (args) => {
      const fullPath = toolbox._resolvePathInWorkspace(args.path, 'path');
      try {
        await fs.access(fullPath);
        return { path: args.path, exists: true };
      } catch {
        return { path: args.path, exists: false };
      }
    },
  );

  toolbox._registerTool(
    'get_file_info',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '获取文件详细信息',
    {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
    async (args) => {
      const fullPath = toolbox._resolvePathInWorkspace(args.path, 'path');
      const stat = await fs.stat(fullPath);
      return {
        path: args.path,
        size: stat.size,
        created: stat.birthtime,
        modified: stat.mtime,
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
      };
    },
  );

  toolbox._registerTool(
    'search_files',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '在文件中搜索内容',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        dir_path: { type: 'string', default: '.' },
        file_pattern: { type: 'string', default: '*' },
        case_sensitive: { type: 'boolean', default: false },
      },
      required: ['pattern'],
    },
    async (args) => {
      const results = [];
      const searchDir = toolbox._resolvePathInWorkspace(args.dir_path || '.', 'dir_path');
      await searchInDir(
        searchDir,
        args.pattern,
        args.file_pattern,
        args.case_sensitive,
        results,
        toolbox._getWorkspaceRoot(),
      );
      return { pattern: args.pattern, matches: results, count: results.length };
    },
  );

  toolbox._registerTool(
    'glob_pattern',
    TOOL_CATEGORIES.FILE_SYSTEM,
    '使用 glob 模式匹配文件',
    {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        dir_path: { type: 'string', default: '.' },
      },
      required: ['pattern'],
    },
    async (args) => {
      const { glob } = await import('glob');
      const searchPath = toolbox._resolvePathInWorkspace(args.dir_path || '.', 'dir_path');
      const matches = await glob(args.pattern, { cwd: searchPath });
      return { pattern: args.pattern, matches, count: matches.length };
    },
  );
}
