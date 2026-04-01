/**
 * Agent Adapter 基类
 * 定义 Agent 调用的标准接口
 * 
 * 支持集成 UniversalToolbox，让 Agent 能够：
 * - 使用文件系统工具读写文件
 * - 执行 Bash/PowerShell 命令
 * - 调用 Git 操作
 * - 使用 LSP 获取代码信息
 * - 管理任务和工作流
 */

import { UniversalToolbox } from './universal-toolbox.js';
import { EventEmitter } from 'events';

export class AgentAdapter extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.name = config.name;
    this.type = config.type;
    this.capabilities = config.capabilities || [];
    
    this._initToolbox(config);
  }

  /**
   * 初始化工具箱
   * @private
   */
  _initToolbox(config) {
    const toolboxConfig = {
      workspace_root: config.workspace_root || config.project_root || process.cwd(),
      timeout: config.tool_timeout || 30000,
      max_output_size: config.max_output_size || 1024 * 1024
    };
    
    this.toolbox = new UniversalToolbox(toolboxConfig);
    this._toolCache = new Map();
  }

  /**
   * 获取可用工具列表
   * @returns {Array} 工具元数据数组
   */
  getTools() {
    return this.toolbox.getToolsMetadata();
  }

  /**
   * 获取工具分类的工具
   * @param {string} category
   * @returns {Array}
   */
  getToolsByCategory(category) {
    return this.toolbox.getToolsMetadata().filter(t => t.category === category);
  }

  /**
   * 搜索工具
   * @param {string} query
   * @returns {Array}
   */
  searchTools(query) {
    return this.toolbox.getToolsMetadata().filter(t => 
      t.name.toLowerCase().includes(query.toLowerCase()) ||
      t.description.toLowerCase().includes(query.toLowerCase())
    );
  }

  /**
   * 执行工具（带缓存）
   * @param {string} toolName
   * @param {Object} args
   * @returns {Promise<Object>}
   */
  async executeTool(toolName, args = {}) {
    this.emit('action', { type: 'tool_call', tool: toolName, args });
    
    const cacheKey = `${toolName}:${JSON.stringify(args)}`;
    
    if (this._toolCache.has(cacheKey)) {
      return this._toolCache.get(cacheKey);
    }
    
    const result = await this.toolbox.execute(toolName, args);
    
    if (result.success) {
      this._toolCache.set(cacheKey, result);
    }
    
    return result;
  }

  /**
   * 清除工具缓存
   */
  clearToolCache() {
    this._toolCache.clear();
  }

  /**
   * 批量执行工具
   * @param {Array} toolCalls - [{tool: string, args: object}]
   * @returns {Promise<Array>}
   */
  async executeToolsBatch(toolCalls) {
    const results = [];
    for (const call of toolCalls) {
      results.push(await this.executeTool(call.tool, call.args));
    }
    return results;
  }

  /**
   * 获取项目上下文（使用工具读取）
   * @param {string} projectRoot
   * @returns {Promise<Object>}
   */
  async getProjectContext(projectRoot) {
    const context = {
      root: projectRoot,
      files: [],
      structure: {}
    };

    const listResult = await this.executeTool('list_directory', { 
      dir_path: projectRoot,
      include_hidden: false
    });

    if (listResult.success && listResult.result.items) {
      context.structure = listResult.result;
      context.files = listResult.result.items
        .filter(i => i.type === 'file')
        .map(f => f.name);
    }

    const packageJsonResult = await this.executeTool('read_file', { 
      file_path: 'package.json' 
    });
    if (packageJsonResult.success) {
      try {
        context.packageJson = JSON.parse(packageJsonResult.result.content);
      } catch {}
    }

    const readmeResult = await this.executeTool('read_file', { 
      file_path: 'README.md' 
    });
    if (readmeResult.success) {
      context.readme = readmeResult.result.content.substring(0, 500);
    }

    return context;
  }

  /**
   * 执行任务
   * @param {Object} task - 任务描述
   * @param {string} task.id - 任务 ID
   * @param {string} task.description - 任务描述
   * @param {string[]} task.files - 相关文件列表
   * @param {Object} task.context - 额外上下文
   * @returns {Promise<Object>} 执行结果
   */
  async execute(task) {
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * 验证 Agent 是否可用
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    throw new Error('healthCheck() must be implemented by subclass');
  }

  /**
   * 获取 Agent 元信息
   * @returns {Object}
   */
  getInfo() {
    return {
      name: this.name,
      type: this.type,
      capabilities: this.capabilities || [],
      tools_count: this.toolbox?.tools?.size || 0
    };
  }

  /**
   * 标准化错误处理
   * @param {Error} error
   * @returns {Object}
   */
  handleError(error) {
    return {
      success: false,
      error: {
        type: error.name,
        message: error.message,
        stack: error.stack
      },
      agent: this.name,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 清理资源
   */
  async cleanup() {
    if (this.toolbox) {
      await this.toolbox.cleanup();
    }
    this._toolCache.clear();
  }
}

/**
 * Agent 执行结果标准格式
 */
export const RESULT_FORMAT = {
  task_id: 'string',
  agent: 'string',
  status: 'success | failed | partial',
  output: {
    files_created: [],
    files_modified: [],
    tests_run: false,
    summary: 'string'
  },
  metrics: {
    duration_ms: 0,
    tokens_used: 0
  },
  errors: []
};

export default AgentAdapter;
