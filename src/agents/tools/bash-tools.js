import { spawn, exec } from 'child_process';
import { TOOL_CATEGORIES } from '../universal-toolbox.js';

export function registerBashTools(toolbox) {
  toolbox._registerTool(
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
        const cwd = toolbox._resolveCwdInWorkspace(args.cwd);
        exec(
          args.command,
          {
            cwd,
            timeout: args.timeout || toolbox.config.timeout,
            maxBuffer: toolbox.config.max_output_size,
          },
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
      const fullPath = toolbox._resolvePathInWorkspace(args.script_path, 'script_path');
      const scriptArgs = (args.args || []).join(' ');
      return toolbox.execute('bash_execute', { command: `bash "${fullPath}" ${scriptArgs}` });
    },
  );

  toolbox._registerTool(
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
      return toolbox.execute('bash_execute', { command: pipeline });
    },
  );

  toolbox._registerTool(
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
      const cwd = toolbox._resolveCwdInWorkspace(args.cwd);
      const proc = spawn(args.command, [], { cwd, shell: true, detached: true });
      const pid = proc.pid;
      toolbox.bashProcesses.set(pid, proc);

      proc.unref();

      return { pid, command: args.command, status: 'started' };
    },
  );

  toolbox._registerTool(
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
      const proc = toolbox.bashProcesses.get(args.pid);
      if (!proc) {
        return { pid: args.pid, status: 'not_found' };
      }
      return { pid: args.pid, status: proc.killed ? 'killed' : 'running' };
    },
  );

  toolbox._registerTool(
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
      const filter = args.filter || '';
      const command =
        process.platform === 'win32'
          ? `powershell -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name,Id,CPU,WS | Format-Table -AutoSize"`
          : `ps aux${filter ? ` | grep "${filter}"` : ''} | head -20`;
      const result = await toolbox.execute('bash_execute', { command });
      return result;
    },
  );

  toolbox._registerTool(
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
      const result = await toolbox.execute('bash_execute', {
        command: `kill ${signal} ${args.pid}`,
      });
      toolbox.bashProcesses.delete(args.pid);
      return result;
    },
  );

  toolbox._registerTool(
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
        const cwd = toolbox._resolveCwdInWorkspace(args.cwd);
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
            stdout: outputs.stdout.substring(0, toolbox.config.max_output_size),
            stderr: outputs.stderr.substring(0, toolbox.config.max_output_size),
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
