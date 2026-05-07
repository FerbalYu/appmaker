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

import {
  getWorkspaceRoot,
  isWithinWorkspace,
  resolvePathInWorkspace,
  resolveCwdInWorkspace,
} from './tools/path-safety.js';
import { registerFileTools } from './tools/file-tools.js';
import { registerBashTools } from './tools/bash-tools.js';
import { registerGitTools } from './tools/git-tools.js';
import { registerPackageManagerTools } from './tools/package-manager-tools.js';
import { registerNetworkTools } from './tools/network-tools.js';
import { registerCodeEditTools } from './tools/code-edit-tools.js';
import { registerLspTools } from './tools/lsp-tools.js';
import { registerSubagentTools } from './tools/subagent-tools.js';
import { registerTaskTools } from './tools/task-tools.js';
import { registerWorkflowTools } from './tools/workflow-tools.js';
import { registerMcpTools } from './tools/mcp-tools.js';
import { registerAgentTools } from './tools/agent-tools.js';
import { registerInteractiveTools } from './tools/interactive-tools.js';
import { registerUtilityTools } from './tools/utility-tools.js';

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

export class UniversalToolbox {
  constructor(config = {}) {
    if (process.env.NCF_MOCK === '1' && new.target === UniversalToolbox) {
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

  _getWorkspaceRoot() {
    return getWorkspaceRoot(this.config);
  }

  _isWithinWorkspace(rootPath, targetPath) {
    return isWithinWorkspace(rootPath, targetPath);
  }

  _resolvePathInWorkspace(inputPath, fieldName = 'path') {
    return resolvePathInWorkspace(this.config, inputPath, fieldName);
  }

  _resolveCwdInWorkspace(cwd) {
    return resolveCwdInWorkspace(this.config, cwd);
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

  _isTypeMatch(value, type) {
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'string') return typeof value === 'string';
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'boolean') return typeof value === 'boolean';
    return true;
  }

  _validateToolArgs(toolName, args, inputSchema) {
    if (!inputSchema || inputSchema.type !== 'object') {
      return { valid: true };
    }

    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return {
        valid: false,
        reason: `Invalid arguments for ${toolName}: expected an object`,
        code: 'INVALID_TOOL_ARGS',
      };
    }

    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    for (const field of required) {
      if (args[field] === undefined) {
        return {
          valid: false,
          reason: `Missing required argument: ${field}`,
          code: 'INVALID_TOOL_ARGS',
        };
      }
    }

    const properties = inputSchema.properties || {};
    for (const [key, value] of Object.entries(args)) {
      const fieldSchema = properties[key];
      if (!fieldSchema || !fieldSchema.type) continue;
      if (!this._isTypeMatch(value, fieldSchema.type)) {
        return {
          valid: false,
          reason: `Invalid argument type for ${key}: expected ${fieldSchema.type}`,
          code: 'INVALID_TOOL_ARGS',
        };
      }
    }

    return { valid: true };
  }

  async execute(toolName, args = {}) {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        tool: toolName,
        error: `Tool not found: ${toolName}`,
        error_info: {
          code: 'TOOL_NOT_FOUND',
          type: 'tool_lookup_error',
          message: `Tool not found: ${toolName}`,
        },
        duration_ms: 0,
      };
    }

    const startTime = Date.now();
    try {
      const validation = this._validateToolArgs(toolName, args, tool.inputSchema);
      if (!validation.valid) {
        return {
          success: false,
          tool: toolName,
          error: validation.reason,
          error_info: {
            code: validation.code,
            type: 'validation_error',
            message: validation.reason,
          },
          duration_ms: Date.now() - startTime,
        };
      }
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
        error_info: {
          code: 'TOOL_EXECUTION_FAILED',
          type: error?.name || 'Error',
          message: error?.message || String(error),
        },
        duration_ms: Date.now() - startTime,
      };
    }
  }

  _registerTool(name, category, description, inputSchema, handler) {
    this.tools.set(name, { category, description, inputSchema, handler });
  }

  _registerFileTools() {
    registerFileTools(this);
  }

  _registerBashTools() {
    registerBashTools(this);
  }

  _registerGitTools() {
    registerGitTools(this);
  }

  _registerPackageManagerTools() {
    registerPackageManagerTools(this);
  }

  _registerNetworkTools() {
    registerNetworkTools(this);
  }

  _registerCodeEditTools() {
    registerCodeEditTools(this);
  }

  _registerLspTools() {
    registerLspTools(this);
  }

  _registerSubagentTools() {
    registerSubagentTools(this);
  }

  _registerTaskTools() {
    registerTaskTools(this);
  }

  _registerWorkflowTools() {
    registerWorkflowTools(this);
  }

  _registerMcpTools() {
    registerMcpTools(this);
  }

  _registerAgentTools() {
    registerAgentTools(this);
  }

  _registerInteractiveTools() {
    registerInteractiveTools(this);
  }

  _registerUtilityTools() {
    registerUtilityTools(this);
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
