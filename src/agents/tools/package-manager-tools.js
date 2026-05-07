import { TOOL_CATEGORIES } from '../universal-toolbox.js';

export function registerPackageManagerTools(toolbox) {
  toolbox._registerTool(
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
      return toolbox.execute('bash_execute', {
        command: `npm install ${flags} ${pkg}`,
        cwd: args.cwd,
      });
    },
  );

  toolbox._registerTool(
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
      return toolbox.execute('bash_execute', { command: `npm run ${args.script}`, cwd: args.cwd });
    },
  );

  toolbox._registerTool(
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
      return toolbox.execute('bash_execute', { command: `yarn add ${pkg}`, cwd: args.cwd });
    },
  );

  toolbox._registerTool(
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
      return toolbox.execute('bash_execute', { command: `pnpm add ${pkg}`, cwd: args.cwd });
    },
  );
}
