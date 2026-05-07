import { TOOL_CATEGORIES } from '../universal-toolbox.js';

export function registerGitTools(toolbox) {
  toolbox._registerTool(
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
      return toolbox.execute('bash_execute', { command: 'git status', cwd: args.cwd });
    },
  );

  toolbox._registerTool(
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
      return toolbox.execute('bash_execute', {
        command: `git add -A && git commit -m "${args.message.replace(/"/g, '\\"')}"`,
        cwd: args.cwd,
      });
    },
  );

  toolbox._registerTool(
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
      return toolbox.execute('bash_execute', { command: branch, cwd: args.cwd });
    },
  );

  toolbox._registerTool(
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
      return toolbox.execute('bash_execute', { command: branch, cwd: args.cwd });
    },
  );

  toolbox._registerTool(
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
      return toolbox.execute('bash_execute', { command: cmd, cwd: args.cwd });
    },
  );

  toolbox._registerTool(
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
      return toolbox.execute('bash_execute', { command: `git diff ${target}`, cwd: args.cwd });
    },
  );
}
