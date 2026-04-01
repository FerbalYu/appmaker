/**
 * Universal Toolbox - 万能工具箱
 *
 * 包含 70+ 独立工具模块：
 *
 * 【文件系统类 - 13个】
 * 1. read_file / read_multiple_files / read_directory
 * 2. write_file / create_directory / delete_file
 * 3. move_file / copy_file / list_directory
 * 4. file_exists / get_file_info / search_files / glob_pattern
 * 5. notebook_edit (Jupyter notebook 编辑)
 *
 * 【命令执行类 - 10个】
 * 6. bash_execute / bash_script / bash_pipe / bash_stream
 * 7. bash_background / bash_background_result
 * 8. get_running_processes / kill_process
 * 9. powershell_execute / powershell_script
 *
 * 【Git 操作类 - 6个】
 * 10. git_status / git_commit / git_push / git_pull / git_branch / git_diff
 *
 * 【包管理器类 - 4个】
 * 11. npm_install / npm_run / yarn_install / pnpm_install
 *
 * 【网络请求类 - 7个】
 * 12. http_get / http_post / http_fetch_json / http_download
 * 13. web_fetch / web_search / tool_search
 *
 * 【代码编辑类 - 4个】
 * 14. edit_file / insert_content / remove_content / replace_content
 *
 * 【LSP 集成类 - 4个】
 * 15. lsp_hover / lsp_definition / lsp_diagnostics / lsp_initialize
 *
 * 【任务管理类 - 7个】
 * 16. task_create / task_get / task_list / task_update / task_stop / task_output / task_delete
 *
 * 【规划/工作流类 - 6个】
 * 17. enter_plan_mode / exit_plan_mode
 * 18. enter_worktree / exit_worktree
 * 19. todo_write / cron_schedule
 *
 * 【MCP 集成类 - 4个】
 * 20. mcp_list_tools / mcp_read_resource / mcp_call_tool / mcp_list_servers
 *
 * 【代理编排类 - 5个】
 * 21. send_message / team_create / team_delete / team_list / agent_status
 *
 * 【用户交互类 - 1个】
 * 22. ask_user_question
 *
 * 【辅助工具类 - 4个】
 * 23. regex_search / json_parse / yaml_parse / template_render
 *
 * 总计: 71 个工具
 */

import { promises as fs } from 'fs';
import path from 'path';
import { spawn, exec } from 'child_process';
import https from 'https';
import http from 'http';
import { URL } from 'url';

export const TOOL_CATEGORIES = {
  FILE_SYSTEM: 'file_system',
  BASH: 'bash',
  GIT: 'git',
  PACKAGE_MANAGER: 'package_manager',
  NETWORK: 'network',
  CODE_EDIT: 'code_edit',
  LSP: 'lsp',
  TASK: 'task',
  WORKFLOW: 'workflow',
  MCP: 'mcp',
  AGENT: 'agent',
  SUBAGENT: 'subagent',
  INTERACTIVE: 'interactive',
  UTILITY: 'utility',
};

async function searchInDir(dir, pattern, filePattern, caseSensitive, results, workspaceRoot) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      await searchInDir(fullPath, pattern, filePattern, caseSensitive, results, workspaceRoot);
    } else if (entry.isFile()) {
      if (filePattern === '*' || entry.name.match(new RegExp(filePattern.replace('*', '.*')))) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          lines.forEach((line, idx) => {
            if (regex.test(line)) {
              results.push({
                file: path.relative(workspaceRoot, fullPath),
                line: idx + 1,
                content: line.trim(),
              });
            }
          });
        } catch (_) {
          /* ignore file read errors */
        }
      }
    }
  }
}

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

export class UniversalToolbox {
  constructor(config = {}) {
    if (process.env.APPMAKER_MOCK === '1' && new.target === UniversalToolbox) {
      return new SandboxToolbox(config);
    }

    this.config = {
      workspace_root: config.workspace_root || process.cwd(),
      timeout: config.timeout || 30000,
      max_output_size: config.max_output_size || 1024 * 1024,
      enable_lsp: config.enable_lsp !== false,
      enable_subagent: config.enable_subagent !== false,
      ...config,
    };

    this.tools = new Map();
    this.lspClients = new Map();
    this.subagents = new Map();
    this.bashProcesses = new Map();
    this.tasks = new Map();
    this.teams = new Map();
    this.cronJobs = new Map();
    this.planMode = false;
    this.worktrees = new Map();

    this._registerAllTools();
  }

  _registerAllTools() {
    this._registerFileTools();
    this._registerBashTools();
    this._registerGitTools();
    this._registerPackageManagerTools();
    this._registerNetworkTools();
    this._registerCodeEditTools();
    this._registerLspTools();
    this._registerTaskTools();
    this._registerWorkflowTools();
    this._registerMcpTools();
    this._registerAgentTools();
    this._registerInteractiveTools();
    this._registerUtilityTools();
  }

  getToolsMetadata() {
    const metadata = [];
    for (const [name, tool] of this.tools) {
      metadata.push({
        name,
        category: tool.category,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    return metadata;
  }

  async execute(toolName, args = {}) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        tool: toolName,
        error: `Tool not found: ${toolName}`,
        duration_ms: 0,
      };
    }

    const startTime = Date.now();
    try {
      const result = await tool.handler(args, this.config);
      return {
        success: true,
        tool: toolName,
        result,
        duration_ms: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        tool: toolName,
        error: error.message,
        duration_ms: Date.now() - startTime,
      };
    }
  }

  _registerTool(name, category, description, inputSchema, handler) {
    this.tools.set(name, { category, description, inputSchema, handler });
  }

  _registerFileTools() {
    this._registerTool(
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
        const fullPath = path.resolve(this.config.workspace_root, args.file_path);
        const content = await fs.readFile(fullPath, 'utf-8');
        return { file_path: args.file_path, content, size: content.length };
      },
    );

    this._registerTool(
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
          const fullPath = path.resolve(this.config.workspace_root, fp);
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

    this._registerTool(
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
        const fullPath = path.resolve(this.config.workspace_root, args.file_path);
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

    this._registerTool(
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
        const fullPath = path.resolve(this.config.workspace_root, args.dir_path);
        await fs.mkdir(fullPath, { recursive: args.recursive !== false });
        return { dir_path: args.dir_path, created: true };
      },
    );

    this._registerTool(
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
        const fullPath = path.resolve(this.config.workspace_root, args.path);
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          await fs.rm(fullPath, { recursive: args.recursive });
        } else {
          await fs.unlink(fullPath);
        }
        return { path: args.path, deleted: true };
      },
    );

    this._registerTool(
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
        const src = path.resolve(this.config.workspace_root, args.source);
        const dest = path.resolve(this.config.workspace_root, args.destination);
        await fs.rename(src, dest);
        return { source: args.source, destination: args.destination, moved: true };
      },
    );

    this._registerTool(
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
        const src = path.resolve(this.config.workspace_root, args.source);
        const dest = path.resolve(this.config.workspace_root, args.destination);
        const stat = await fs.stat(src);
        if (stat.isDirectory()) {
          await copyDir(src, dest);
        } else {
          await fs.copyFile(src, dest);
        }
        return { source: args.source, destination: args.destination, copied: true };
      },
    );

    this._registerTool(
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
        const fullPath = path.resolve(this.config.workspace_root, args.dir_path || '.');
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

    this._registerTool(
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
        const fullPath = path.resolve(this.config.workspace_root, args.path);
        try {
          await fs.access(fullPath);
          return { path: args.path, exists: true };
        } catch {
          return { path: args.path, exists: false };
        }
      },
    );

    this._registerTool(
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
        const fullPath = path.resolve(this.config.workspace_root, args.path);
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

    this._registerTool(
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
        const searchDir = path.resolve(this.config.workspace_root, args.dir_path || '.');
        await searchInDir(
          searchDir,
          args.pattern,
          args.file_pattern,
          args.case_sensitive,
          results,
          this.config.workspace_root,
        );
        return { pattern: args.pattern, matches: results, count: results.length };
      },
    );

    this._registerTool(
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
        const searchPath = path.resolve(this.config.workspace_root, args.dir_path || '.');
        const matches = await glob(args.pattern, { cwd: searchPath });
        return { pattern: args.pattern, matches, count: matches.length };
      },
    );
  }

  _registerBashTools() {
    this._registerTool(
      'bash_execute',
      TOOL_CATEGORIES.BASH,
      '执行 Bash 命令',
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
          const cwd = args.cwd
            ? path.resolve(this.config.workspace_root, args.cwd)
            : this.config.workspace_root;
          exec(
            args.command,
            {
              cwd,
              timeout: args.timeout || this.config.timeout,
              maxBuffer: this.config.max_output_size,
            },
            (error, stdout, stderr) => {
              resolve({
                command: args.command,
                stdout: stdout.substring(0, this.config.max_output_size),
                stderr: stderr.substring(0, this.config.max_output_size),
                exit_code: error?.code || 0,
                success: !error,
              });
            },
          );
        });
      },
    );

    this._registerTool(
      'bash_script',
      TOOL_CATEGORIES.BASH,
      '执行 Bash 脚本文件',
      {
        type: 'object',
        properties: {
          script_path: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
        },
        required: ['script_path'],
      },
      async (args) => {
        const fullPath = path.resolve(this.config.workspace_root, args.script_path);
        const scriptArgs = (args.args || []).join(' ');
        return this.execute('bash_execute', { command: `bash "${fullPath}" ${scriptArgs}` });
      },
    );

    this._registerTool(
      'bash_pipe',
      TOOL_CATEGORIES.BASH,
      '使用管道执行多个命令',
      {
        type: 'object',
        properties: {
          commands: { type: 'array', items: { type: 'string' } },
        },
        required: ['commands'],
      },
      async (args) => {
        const pipeline = args.commands.join(' | ');
        return this.execute('bash_execute', { command: pipeline });
      },
    );

    this._registerTool(
      'bash_background',
      TOOL_CATEGORIES.BASH,
      '后台执行命令',
      {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['command'],
      },
      async (args) => {
        const cwd = args.cwd
          ? path.resolve(this.config.workspace_root, args.cwd)
          : this.config.workspace_root;
        const proc = spawn(args.command, [], { cwd, shell: true, detached: true });
        const pid = proc.pid;
        this.bashProcesses.set(pid, proc);

        proc.unref();

        return { pid, command: args.command, status: 'started' };
      },
    );

    this._registerTool(
      'bash_background_result',
      TOOL_CATEGORIES.BASH,
      '获取后台进程输出',
      {
        type: 'object',
        properties: {
          pid: { type: 'number' },
        },
        required: ['pid'],
      },
      async (args) => {
        const proc = this.bashProcesses.get(args.pid);
        if (!proc) {
          return { pid: args.pid, status: 'not_found' };
        }
        return { pid: args.pid, status: proc.killed ? 'killed' : 'running' };
      },
    );

    this._registerTool(
      'get_running_processes',
      TOOL_CATEGORIES.BASH,
      '获取运行中的进程列表',
      {
        type: 'object',
        properties: {
          filter: { type: 'string' },
        },
      },
      async (args) => {
        const filter = args.filter ? ` | grep "${args.filter}"` : '';
        const result = await this.execute('bash_execute', {
          command: `ps aux${filter} | head -20`,
        });
        return result;
      },
    );

    this._registerTool(
      'kill_process',
      TOOL_CATEGORIES.BASH,
      '终止进程',
      {
        type: 'object',
        properties: {
          pid: { type: 'number' },
          force: { type: 'boolean', default: false },
        },
        required: ['pid'],
      },
      async (args) => {
        const signal = args.force ? '-9' : '-15';
        const result = await this.execute('bash_execute', {
          command: `kill ${signal} ${args.pid}`,
        });
        this.bashProcesses.delete(args.pid);
        return result;
      },
    );

    this._registerTool(
      'bash_stream',
      TOOL_CATEGORIES.BASH,
      '流式执行命令（支持实时输出）',
      {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['command'],
      },
      async (args) => {
        return new Promise((resolve) => {
          const cwd = args.cwd
            ? path.resolve(this.config.workspace_root, args.cwd)
            : this.config.workspace_root;
          const outputs = { stdout: '', stderr: '' };
          const proc = spawn(args.command, [], { cwd, shell: true });

          proc.stdout.on('data', (data) => {
            outputs.stdout += data.toString();
          });
          proc.stderr.on('data', (data) => {
            outputs.stderr += data.toString();
          });

          proc.on('close', (code) => {
            resolve({
              command: args.command,
              stdout: outputs.stdout.substring(0, this.config.max_output_size),
              stderr: outputs.stderr.substring(0, this.config.max_output_size),
              exit_code: code,
              success: code === 0,
            });
          });

          proc.on('error', (err) => {
            resolve({ command: args.command, error: err.message, success: false });
          });
        });
      },
    );
  }

  _registerGitTools() {
    this._registerTool(
      'git_status',
      TOOL_CATEGORIES.GIT,
      '获取 Git 状态',
      {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
        },
      },
      async (args) => {
        return this.execute('bash_execute', { command: 'git status', cwd: args.cwd });
      },
    );

    this._registerTool(
      'git_commit',
      TOOL_CATEGORIES.GIT,
      '提交更改',
      {
        type: 'object',
        properties: {
          message: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['message'],
      },
      async (args) => {
        return this.execute('bash_execute', {
          command: `git add -A && git commit -m "${args.message.replace(/"/g, '\\"')}"`,
          cwd: args.cwd,
        });
      },
    );

    this._registerTool(
      'git_push',
      TOOL_CATEGORIES.GIT,
      '推送到远程仓库',
      {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          cwd: { type: 'string' },
        },
      },
      async (args) => {
        const branch = args.branch ? `git push origin ${args.branch}` : 'git push';
        return this.execute('bash_execute', { command: branch, cwd: args.cwd });
      },
    );

    this._registerTool(
      'git_pull',
      TOOL_CATEGORIES.GIT,
      '从远程拉取更新',
      {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          cwd: { type: 'string' },
        },
      },
      async (args) => {
        const branch = args.branch ? `git pull origin ${args.branch}` : 'git pull';
        return this.execute('bash_execute', { command: branch, cwd: args.cwd });
      },
    );

    this._registerTool(
      'git_branch',
      TOOL_CATEGORIES.GIT,
      '管理 Git 分支',
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'delete', 'switch'] },
          name: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['action'],
      },
      async (args) => {
        let cmd;
        switch (args.action) {
          case 'list':
            cmd = 'git branch -a';
            break;
          case 'create':
            cmd = `git branch ${args.name}`;
            break;
          case 'delete':
            cmd = `git branch -d ${args.name}`;
            break;
          case 'switch':
            cmd = `git checkout ${args.name}`;
            break;
          default:
            throw new Error(`Unknown action: ${args.action}`);
        }
        return this.execute('bash_execute', { command: cmd, cwd: args.cwd });
      },
    );

    this._registerTool(
      'git_diff',
      TOOL_CATEGORIES.GIT,
      '查看差异',
      {
        type: 'object',
        properties: {
          target: { type: 'string' },
          cwd: { type: 'string' },
        },
      },
      async (args) => {
        const target = args.target || '';
        return this.execute('bash_execute', { command: `git diff ${target}`, cwd: args.cwd });
      },
    );
  }

  _registerPackageManagerTools() {
    this._registerTool(
      'npm_install',
      TOOL_CATEGORIES.PACKAGE_MANAGER,
      '安装 npm 依赖',
      {
        type: 'object',
        properties: {
          package: { type: 'string' },
          flags: { type: 'string' },
          cwd: { type: 'string' },
        },
      },
      async (args) => {
        const pkg = args.package || '';
        const flags = args.flags || '-D';
        return this.execute('bash_execute', {
          command: `npm install ${flags} ${pkg}`,
          cwd: args.cwd,
        });
      },
    );

    this._registerTool(
      'npm_run',
      TOOL_CATEGORIES.PACKAGE_MANAGER,
      '运行 npm 脚本',
      {
        type: 'object',
        properties: {
          script: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['script'],
      },
      async (args) => {
        return this.execute('bash_execute', { command: `npm run ${args.script}`, cwd: args.cwd });
      },
    );

    this._registerTool(
      'yarn_install',
      TOOL_CATEGORIES.PACKAGE_MANAGER,
      '安装 yarn 依赖',
      {
        type: 'object',
        properties: {
          package: { type: 'string' },
          cwd: { type: 'string' },
        },
      },
      async (args) => {
        const pkg = args.package || '';
        return this.execute('bash_execute', { command: `yarn add ${pkg}`, cwd: args.cwd });
      },
    );

    this._registerTool(
      'pnpm_install',
      TOOL_CATEGORIES.PACKAGE_MANAGER,
      '安装 pnpm 依赖',
      {
        type: 'object',
        properties: {
          package: { type: 'string' },
          cwd: { type: 'string' },
        },
      },
      async (args) => {
        const pkg = args.package || '';
        return this.execute('bash_execute', { command: `pnpm add ${pkg}`, cwd: args.cwd });
      },
    );
  }

  _registerNetworkTools() {
    this._registerTool(
      'http_get',
      TOOL_CATEGORIES.NETWORK,
      '发送 GET 请求',
      {
        type: 'object',
        properties: {
          url: { type: 'string' },
          headers: { type: 'object' },
        },
        required: ['url'],
      },
      async (args) => {
        return this.httpRequest('GET', args.url, null, args.headers);
      },
    );

    this._registerTool(
      'http_post',
      TOOL_CATEGORIES.NETWORK,
      '发送 POST 请求',
      {
        type: 'object',
        properties: {
          url: { type: 'string' },
          body: { type: 'string' },
          headers: { type: 'object' },
        },
        required: ['url', 'body'],
      },
      async (args) => {
        return this.httpRequest('POST', args.url, args.body, args.headers);
      },
    );

    this._registerTool(
      'http_fetch_json',
      TOOL_CATEGORIES.NETWORK,
      '获取并解析 JSON',
      {
        type: 'object',
        properties: {
          url: { type: 'string' },
          headers: { type: 'object' },
        },
        required: ['url'],
      },
      async (args) => {
        const result = await this.httpRequest('GET', args.url, null, args.headers);
        try {
          result.json = JSON.parse(result.body);
          return result;
        } catch {
          return { ...result, json: null, parse_error: 'Failed to parse JSON' };
        }
      },
    );

    this._registerTool(
      'http_download',
      TOOL_CATEGORIES.NETWORK,
      '下载文件',
      {
        type: 'object',
        properties: {
          url: { type: 'string' },
          dest: { type: 'string' },
        },
        required: ['url', 'dest'],
      },
      async (args) => {
        const destPath = path.resolve(this.config.workspace_root, args.dest);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        const file = await fs.open(destPath, 'w');

        return new Promise((resolve) => {
          const urlObj = new URL(args.url);
          const client = urlObj.protocol === 'https:' ? https : http;

          client
            .get(args.url, (response) => {
              if (
                response.statusCode >= 300 &&
                response.statusCode < 400 &&
                response.headers.location
              ) {
                this.httpDownload(response.headers.location, destPath).then(resolve);
                return;
              }

              response.pipe(file);
              response.on('end', () => {
                file.close();
                resolve({ url: args.url, dest: args.dest, downloaded: true });
              });
            })
            .on('error', async (err) => {
              await file.close();
              resolve({ url: args.url, dest: args.dest, error: err.message });
            });
        });
      },
    );
  }

  httpRequest(method, url, body, headers = {}) {
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers: {
          'User-Agent': 'appMaker-UniversalToolbox/1.0',
          ...headers,
        },
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status_code: res.statusCode,
            headers: res.headers,
            body: data.substring(0, this.config.max_output_size),
          });
        });
      });

      req.on('error', (err) => resolve({ error: err.message }));
      if (body) req.write(body);
      req.end();
    });
  }

  async httpDownload(url, destPath) {
    return this.execute('http_download', {
      url,
      dest: path.relative(this.config.workspace_root, destPath),
    });
  }

  _registerCodeEditTools() {
    this._registerTool(
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
        return this.execute('write_file', { file_path: args.file_path, content: args.content });
      },
    );

    this._registerTool(
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
        const fullPath = path.resolve(this.config.workspace_root, args.file_path);
        const lines = (await fs.readFile(fullPath, 'utf-8')).split('\n');
        lines.splice(args.after_line, 0, args.content);
        await fs.writeFile(fullPath, lines.join('\n'), 'utf-8');
        return { file_path: args.file_path, inserted_at_line: args.after_line };
      },
    );

    this._registerTool(
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
        const fullPath = path.resolve(this.config.workspace_root, args.file_path);
        const lines = (await fs.readFile(fullPath, 'utf-8')).split('\n');
        lines.splice(args.start_line - 1, args.end_line - args.start_line + 1);
        await fs.writeFile(fullPath, lines.join('\n'), 'utf-8');
        return { file_path: args.file_path, removed_lines: `${args.start_line}-${args.end_line}` };
      },
    );

    this._registerTool(
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
        const fullPath = path.resolve(this.config.workspace_root, args.file_path);
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

  _registerLspTools() {
    this._registerTool(
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
        return this.lspRequest(args.language_server, 'textDocument/hover', {
          textDocument: {
            uri: `file://${path.resolve(this.config.workspace_root, args.file_path)}`,
          },
          position: { line: args.line, character: args.character },
        });
      },
    );

    this._registerTool(
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
        return this.lspRequest(args.language_server, 'textDocument/definition', {
          textDocument: {
            uri: `file://${path.resolve(this.config.workspace_root, args.file_path)}`,
          },
          position: { line: args.line, character: args.character },
        });
      },
    );

    this._registerTool(
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
        return this.lspRequest(args.language_server, 'textDocument/diagnostic', {
          textDocument: {
            uri: `file://${path.resolve(this.config.workspace_root, args.file_path)}`,
          },
        });
      },
    );

    this._registerTool(
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
              name: `appMaker-LSP-${args.language}`,
              version: '1.0.0',
            },
            {},
          );

          await client.connect(transport);
          this.lspClients.set(args.language, client);
          return { language: args.language, status: 'initialized' };
        } catch (err) {
          return { language: args.language, status: 'failed', error: err.message };
        }
      },
    );
  }

  async lspRequest(server, method, params) {
    const client = this.lspClients.get(server);
    if (!client) {
      return { error: `LSP server not initialized: ${server}` };
    }
    try {
      return await client.sendRequest(method, params);
    } catch (err) {
      return { error: err.message };
    }
  }

  _registerSubagentTools() {
    this._registerTool(
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
        this.subagents.set(agentId, subagent);
        return { subagent_id: agentId, ...subagent };
      },
    );

    this._registerTool(
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
        const subagent = this.subagents.get(args.subagent_id);
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

    this._registerTool(
      'list_subagents',
      TOOL_CATEGORIES.SUBAGENT,
      '列出所有子代理',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const agents = [];
        for (const [id, agent] of this.subagents) {
          agents.push(agent);
        }
        return { subagents: agents, count: agents.length };
      },
    );

    this._registerTool(
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
        const subagent = this.subagents.get(args.subagent_id);
        if (!subagent) {
          return { error: `Subagent not found: ${args.subagent_id}` };
        }
        subagent.status = 'terminated';
        subagent.terminated_at = new Date().toISOString();
        return { subagent_id: args.subagent_id, status: 'terminated' };
      },
    );
  }

  _registerTaskTools() {
    this._registerTool(
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
        this.tasks.set(taskId, task);
        return { task_id: taskId, ...task };
      },
    );

    this._registerTool(
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
        const task = this.tasks.get(args.task_id);
        if (!task) {
          return { error: `Task not found: ${args.task_id}` };
        }
        return { task: { ...task } };
      },
    );

    this._registerTool(
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
        let tasks = Array.from(this.tasks.values());
        if (args.status && args.status !== 'all') {
          tasks = tasks.filter((t) => t.status === args.status);
        }
        if (args.tags && args.tags.length > 0) {
          tasks = tasks.filter((t) => args.tags.some((tag) => t.tags.includes(tag)));
        }
        return { tasks, count: tasks.length };
      },
    );

    this._registerTool(
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
        const task = this.tasks.get(args.task_id);
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

    this._registerTool(
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
        const task = this.tasks.get(args.task_id);
        if (!task) {
          return { error: `Task not found: ${args.task_id}` };
        }
        task.status = 'cancelled';
        task.stopped_at = new Date().toISOString();
        return { task_id: args.task_id, stopped: true };
      },
    );

    this._registerTool(
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
        const task = this.tasks.get(args.task_id);
        if (!task) {
          return { error: `Task not found: ${args.task_id}` };
        }
        return { task_id: args.task_id, output: task.output || null, status: task.status };
      },
    );

    this._registerTool(
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
        if (!this.tasks.has(args.task_id)) {
          return { error: `Task not found: ${args.task_id}` };
        }
        this.tasks.delete(args.task_id);
        return { task_id: args.task_id, deleted: true };
      },
    );
  }

  _registerWorkflowTools() {
    this._registerTool(
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
        this.planMode = true;
        this.planContext = args.context || {};
        return { plan_mode: true, context: this.planContext, entered_at: new Date().toISOString() };
      },
    );

    this._registerTool(
      'exit_plan_mode',
      TOOL_CATEGORIES.WORKFLOW,
      '退出规划模式',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const context = this.planContext;
        this.planMode = false;
        this.planContext = null;
        return { plan_mode: false, context, exited_at: new Date().toISOString() };
      },
    );

    this._registerTool(
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
        this.worktrees.set(worktreeId, {
          id: worktreeId,
          name: args.name,
          base_branch: args.base_branch || 'main',
          created_at: new Date().toISOString(),
          active: true,
        });
        return { worktree_id: worktreeId, name: args.name, base_branch: args.base_branch };
      },
    );

    this._registerTool(
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
        const worktree = this.worktrees.get(args.worktree_id);
        if (!worktree) {
          return { error: `Worktree not found: ${args.worktree_id}` };
        }
        worktree.active = false;
        worktree.exited_at = new Date().toISOString();
        return { worktree_id: args.worktree_id, exited: true };
      },
    );

    this._registerTool(
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

    this._registerTool(
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
        this.cronJobs.set(jobId, {
          id: jobId,
          expression: args.expression,
          task: args.task,
          enabled: args.enabled !== false,
          created_at: new Date().toISOString(),
          last_run: null,
          next_run: this._calculateNextRun(args.expression),
        });
        return { job_id: jobId, expression: args.expression, enabled: args.enabled };
      },
    );

    this._registerTool(
      'cron_list',
      TOOL_CATEGORIES.WORKFLOW,
      '列出定时任务',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const jobs = Array.from(this.cronJobs.values());
        return { jobs, count: jobs.length };
      },
    );

    this._registerTool(
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
        if (!this.cronJobs.has(args.job_id)) {
          return { error: `Cron job not found: ${args.job_id}` };
        }
        this.cronJobs.delete(args.job_id);
        return { job_id: args.job_id, deleted: true };
      },
    );
  }

  _calculateNextRun(cronExpr) {
    return new Date(Date.now() + 60000).toISOString();
  }

  _registerMcpTools() {
    this._registerTool(
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
        const client = this.lspClients.get(args.server_name || 'default');
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

    this._registerTool(
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
        const client = this.lspClients.get(args.server_name || 'default');
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

    this._registerTool(
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
        const client = this.lspClients.get(args.server_name || 'default');
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

    this._registerTool(
      'mcp_list_servers',
      TOOL_CATEGORIES.MCP,
      '列出所有 MCP 服务器',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const servers = Array.from(this.lspClients.entries()).map(([name, client]) => ({
          name,
          connected: true,
        }));
        return { servers, count: servers.length };
      },
    );
  }

  _registerAgentTools() {
    this._registerTool(
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

    this._registerTool(
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
        this.teams.set(teamId, team);
        return { team_id: teamId, name: args.name, agents_count: team.agents.length };
      },
    );

    this._registerTool(
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
        if (!this.teams.has(args.team_id)) {
          return { error: `Team not found: ${args.team_id}` };
        }
        this.teams.delete(args.team_id);
        return { team_id: args.team_id, deleted: true };
      },
    );

    this._registerTool(
      'team_list',
      TOOL_CATEGORIES.AGENT,
      '列出所有代理团队',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const teams = Array.from(this.teams.values());
        return { teams, count: teams.length };
      },
    );

    this._registerTool(
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
        const agent = this.subagents.get(args.agent_id) || { status: 'unknown' };
        return { agent_id: args.agent_id, status: agent.status || 'unknown' };
      },
    );
  }

  _registerInteractiveTools() {
    this._registerTool(
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

    this._registerTool(
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
        const fullPath = path.resolve(this.config.workspace_root, args.file_path);
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

    this._registerTool(
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
          const cwd = args.cwd
            ? path.resolve(this.config.workspace_root, args.cwd)
            : this.config.workspace_root;
          const psCommand = args.command.includes('powershell')
            ? args.command
            : `powershell -Command "${args.command.replace(/"/g, '\\"')}"`;
          exec(
            psCommand,
            { cwd, timeout: args.timeout || this.config.timeout },
            (error, stdout, stderr) => {
              resolve({
                command: args.command,
                stdout: stdout.substring(0, this.config.max_output_size),
                stderr: stderr.substring(0, this.config.max_output_size),
                exit_code: error?.code || 0,
                success: !error,
              });
            },
          );
        });
      },
    );

    this._registerTool(
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
            headers: { 'User-Agent': 'appMaker/1.0' },
          });
          const text = await response.text();
          return {
            url: args.url,
            status: response.status,
            content: text.substring(0, this.config.max_output_size),
            content_type: response.headers.get('content-type'),
          };
        } catch (err) {
          return { url: args.url, error: err.message };
        }
      },
    );

    this._registerTool(
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

    this._registerTool(
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
        const allTools = this.getToolsMetadata();
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

  _registerUtilityTools() {
    this._registerTool(
      'regex_search',
      TOOL_CATEGORIES.UTILITY,
      '正则表达式搜索',
      {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          flags: { type: 'string', default: 'g' },
          content: { type: 'string' },
        },
        required: ['pattern', 'content'],
      },
      async (args) => {
        try {
          const regex = new RegExp(args.pattern, args.flags);
          const matches = [...args.content.matchAll(regex)];
          return {
            matches: matches.map((m) => ({
              match: m[0],
              index: m.index,
              groups: m.groups || null,
            })),
            count: matches.length,
          };
        } catch (err) {
          return { error: `Invalid regex: ${err.message}` };
        }
      },
    );

    this._registerTool(
      'json_parse',
      TOOL_CATEGORIES.UTILITY,
      '解析 JSON',
      {
        type: 'object',
        properties: {
          content: { type: 'string' },
        },
        required: ['content'],
      },
      async (args) => {
        try {
          return { parsed: JSON.parse(args.content), success: true };
        } catch (err) {
          return { error: `JSON parse error: ${err.message}`, success: false };
        }
      },
    );

    this._registerTool(
      'yaml_parse',
      TOOL_CATEGORIES.UTILITY,
      '解析 YAML',
      {
        type: 'object',
        properties: {
          content: { type: 'string' },
        },
        required: ['content'],
      },
      async (args) => {
        try {
          const { parse } = await import('yaml');
          return { parsed: parse(args.content), success: true };
        } catch (err) {
          return { error: `YAML parse error: ${err.message}`, success: false };
        }
      },
    );

    this._registerTool(
      'template_render',
      TOOL_CATEGORIES.UTILITY,
      '模板渲染',
      {
        type: 'object',
        properties: {
          template: { type: 'string' },
          variables: { type: 'object' },
        },
        required: ['template', 'variables'],
      },
      async (args) => {
        let result = args.template;
        for (const [key, value] of Object.entries(args.variables)) {
          const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
          result = result.replace(regex, String(value));
        }
        return { rendered: result, success: true };
      },
    );
  }

  async cleanup() {
    for (const [pid, proc] of this.bashProcesses) {
      try {
        proc.kill();
      } catch (_) {
        /* ignore kill errors */
      }
    }
    this.bashProcesses.clear();

    for (const [name, client] of this.lspClients) {
      try {
        if (typeof client.stop === 'function') {
          await client.stop();
        }
      } catch (_) {
        /* ignore stop errors */
      }
    }
    this.lspClients.clear();

    this.tasks.clear();
    this.teams.clear();
    this.worktrees.clear();
    this.cronJobs.clear();
  }
}

export class SandboxToolbox extends UniversalToolbox {
  constructor(config = {}) {
    super(config);
    this.name = 'sandbox-toolbox';
    this._log('WARN', 'SandboxToolbox initialized. DANGEROUS operations will be simulated.');
  }

  _log(level, msg) {
    if (this.config.logger && typeof this.config.logger[level.toLowerCase()] === 'function') {
      this.config.logger[level.toLowerCase()](`[SandboxToolbox] ${msg}`);
    } else {
      console.log(`[SandboxToolbox][${level}] ${msg}`);
    }
  }

  async execute(toolName, args = {}) {
    this._log('INFO', `Executing tool [${toolName}] in sandbox mode...`);

    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        tool: toolName,
        error: `Tool not found: ${toolName}`,
        duration_ms: 0,
      };
    }

    // 拦截有副作用的种类
    const DANGEROUS_CATEGORIES = ['bash', 'code_edit', 'git', 'package_manager'];

    const DANGEROUS_TOOLS = [
      'write_file',
      'delete_file',
      'create_directory',
      'move_file',
      'copy_file',
      'http_post',
      'http_download',
    ];

    if (DANGEROUS_CATEGORIES.includes(tool.category) || DANGEROUS_TOOLS.includes(toolName)) {
      this._log('WARN', `BLOCKED dangerous tool execution: ${toolName}. Simulating success.`);

      return {
        success: true,
        tool: toolName,
        simulated: true,
        result: {
          simulated_success: true,
          message: `[SANDBOX] The tool ${toolName} was intercepted and simulated.`,
          args,
        },
        duration_ms: 10,
      };
    }

    return super.execute(toolName, args);
  }
}

export default UniversalToolbox;
