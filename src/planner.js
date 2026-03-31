/**
 * Planner - 自然语言需求 → 执行计划
 * 
 * 核心能力：
 * - AI 驱动的需求分析与任务分解
 * - 智能依赖关系推理
 * - 多级里程碑规划
 * - 优雅降级的规则分析回退
 */

import { promises as fs } from 'fs';
import path from 'path';
import { AgentDispatcher } from './agents/dispatcher.js';
import { NativeCoderAdapter } from './agents/native-coder.js';
import { MinimaxMCPAdapter } from './agents/minimax-mcp.js';
import { UniversalToolbox } from './agents/universal-toolbox.js';
import { config } from '../config/index.js';

export class Planner {
  constructor(configOverrides = {}) {
    this.config = {
      max_tasks_per_milestone: 5,
      max_total_tasks: 20,
      token_budget: 30000,
      ...config,
      ...configOverrides
    };
    this.projectRoot = this.config.project_root || process.cwd();

    this.dispatcher = new AgentDispatcher({
      ...this.config.dispatcher,
      ...(this.config.agents?.['native-reviewer'] || {}),
      ...(this.config.agents?.['native-coder'] || {})
    });
    this.dispatcher.registerAgent('native-coder', new NativeCoderAdapter({
      ...this.config.agents?.['native-coder'],
      ...configOverrides
    }));
    this.dispatcher.registerAgent('minimax-mcp', new MinimaxMCPAdapter({
      ...this.config.agents?.['minimax-mcp'],
      ...configOverrides
    }));

    this.toolbox = new UniversalToolbox({
      workspace_root: this.projectRoot
    });
  }

  /**
   * 获取工具列表
   */
  getTools() {
    return this.toolbox.getToolsMetadata();
  }

  /**
   * 使用工具执行操作
   */
  async executeTool(toolName, args) {
    return this.toolbox.execute(toolName, args);
  }

  /**
   * 生成任务清单到 todo_write
   */
  async syncTasksToTodo(plan) {
    const todoItems = plan.tasks.map(task => ({
      content: `[${task.id}] ${task.description}`,
      status: 'pending',
      priority: task.type === 'architect' ? 'high' : 'medium'
    }));

    const result = await this.toolbox.execute('todo_write', { todos: todoItems });
    console.log(`[Planner] 📝 任务清单已同步: ${result.result?.count || 0} 项`);
    return result;
  }

  /**
   * 创建项目任务记录
   */
  async createProjectTasks(plan) {
    const results = [];
    for (const task of plan.tasks) {
      const result = await this.toolbox.execute('task_create', {
        title: `[${task.id}] ${task.description}`,
        description: `类型: ${task.type} | 依赖: ${task.dependencies.join(', ') || '无'}`,
        priority: task.type === 'architect' ? 'high' : 'medium',
        tags: [task.type, plan.project?.name]
      });
      if (result.success) {
        results.push({ taskId: task.id, ...result.result });
      }
    }
    return results;
  }

  /**
   * 获取当前项目任务状态
   */
  async getTaskStatus() {
    const result = await this.toolbox.execute('task_list', {});
    return result;
  }

  /**
   * 清理项目任务
   */
  async cleanupTasks() {
    const listResult = await this.toolbox.execute('task_list', {});
    if (listResult.success && listResult.result.tasks) {
      for (const task of listResult.result.tasks) {
        await this.toolbox.execute('task_delete', { task_id: task.id });
      }
    }
  }

  /**
   * 从自然语言生成执行计划
   * @param {string} requirement
   * @returns {Promise<Object>}
   */
  async plan(requirement) {
    console.log(`[Planner] 🤖 开始 AI 深度需求分析...`);
    console.log(`[Planner] 需求: "${requirement.substring(0, 80)}${requirement.length > 80 ? '...' : ''}"`);

    const enhancedPrompt = this._buildPlanningPrompt(requirement);
    const startTime = Date.now();

    this._showSpinner(startTime, 'AI 分析中');

    const plannerAgentName = this.config.planner_agent || 'native-coder';

    try {
      const agentResult = await this.dispatcher.dispatch({
        id: 'plan_analysis',
        type: 'analysis',
        description: plannerAgentName === 'native-coder' ? enhancedPrompt : requirement,
        agent: plannerAgentName,
        context: { 
          project_root: this.projectRoot,
          requirement,
          planning_config: {
            max_tasks: this.config.max_total_tasks,
            max_per_milestone: this.config.max_tasks_per_milestone,
            token_budget: this.config.token_budget
          }
        }
      });

      this._clearSpinner();
      
      if (process.env.PLANNER_DEBUG) {
        console.log('\n[Planner] 📋 AI 返回内容:');
        console.log(JSON.stringify(agentResult, null, 2).substring(0, 1500));
        console.log('--------------------\n');
      }

      const content = this._extractJSON(
        agentResult.output?.raw_output ||
        agentResult.output?.summary ||
        agentResult.output?.review_report ||
        agentResult.result ||
        String(agentResult)
      );

      const parsedPlan = JSON.parse(content);
      const finalizedPlan = this._finalizePlan(parsedPlan, requirement);
      
      console.log(`[Planner] ✅ 计划生成成功`);
      console.log(`[Planner] 📋 任务数: ${finalizedPlan.tasks.length} | 里程碑: ${finalizedPlan.milestones.length}`);
      console.log(`[Planner] ⏱️ 预估耗时: ${finalizedPlan.metadata.total_minutes_estimate} 分钟`);
      
      return finalizedPlan;
    } catch (e) {
      this._clearSpinner();
      
      console.log(`[Planner] ⚠️ AI 分析失败 (${e.message})，使用规则分析回退`);
      
      if (process.env.DEBUG || process.env.PLANNER_DEBUG) {
        console.log('[Planner] 📋 调试信息:');
        console.log(JSON.stringify(agentResult || {}, null, 2).substring(0, 1000));
      }

      return this._generateFallbackPlan(requirement);
    }
  }

  /**
   * 构建增强的规划 prompt
   * @private
   */
  _buildPlanningPrompt(requirement) {
    return `你是一个资深软件架构师，擅长将复杂需求分解为可执行的任务计划。

## 任务
深度分析以下需求，生成一个结构化的执行计划。输出必须是合法的 JSON 格式（不含 Markdown 包裹）。

## 需求描述
${requirement}

## 输出要求
严格按照以下 JSON Schema 输出，不要包含任何其他文字：

{
  "project": {
    "name": "项目英文名称（2-4个词，用驼峰或连字符）",
    "description": "一句话核心功能描述（20字内）"
  },
  "features": ["核心特性1", "核心特性2"],
  "tasks": [
    {
      "id": "t1",
      "description": "具体可执行的任务描述",
      "type": "architect | create | modify | test | integrate | deploy | docs",
      "dependencies": [],
      "agent": "native-coder",
      "estimated_tokens": 2000,
      "estimated_minutes": 10
    }
  ],
  "milestones": [
    {
      "id": "m1",
      "name": "里程碑名称",
      "tasks": ["t1", "t2"]
    }
  ]
}

## 任务分解原则
1. 每个任务应该是 10-20 分钟可完成的工作单元
2. 任务之间必须有明确的依赖关系
3. 按照：基础框架 → 核心功能 → 增强功能 → 集成测试 → 部署上线 的顺序安排
4. 总任务数控制在 ${this.config.max_total_tasks} 个以内
5. 每个里程碑包含 2-5 个任务

## 任务类型说明
- architect: 项目结构设计和技术选型
- create: 新功能开发
- modify: 现有功能修改
- test: 测试编写
- integrate: 模块集成
- deploy: 部署配置
- docs: 文档编写

请立即输出 JSON（不要有任何前缀或后缀文字）：`;
  }

  /**
   * 显示加载动画
   * @private
   */
  _showSpinner(startTime, message) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIndex = 0;
    
    this._spinnerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const frame = frames[frameIndex % frames.length];
      process.stdout.write(`\r[Planner] ${frame} ${message} (${elapsed}s)  `);
      frameIndex++;
    }, 100);
  }

  /**
   * 清除加载动画
   * @private
   */
  _clearSpinner() {
    if (this._spinnerInterval) {
      clearInterval(this._spinnerInterval);
      this._spinnerInterval = null;
    }
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
  }

  _extractJSON(output) {
    if (typeof output !== 'string') {
      const str = JSON.stringify(output);
      if (process.env.PLANNER_DEBUG) {
        console.log('[Planner] _extractJSON: output 不是字符串，已转换为:', str.substring(0, 200));
      }
      return str;
    }

    const codeBlocks = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    if (codeBlocks.length > 0) {
      if (process.env.PLANNER_DEBUG) {
        console.log(`[Planner] _extractJSON: 发现 ${codeBlocks.length} 个代码块`);
      }
      for (const match of codeBlocks) {
        try {
          const parsed = JSON.parse(match[1].trim());
          if (process.env.PLANNER_DEBUG) {
            console.log('[Planner] _extractJSON: 代码块解析成功');
          }
          return JSON.stringify(parsed);
        } catch (e) {
          if (process.env.PLANNER_DEBUG) {
            console.log(`[Planner] _extractJSON: 代码块解析失败: ${e.message}`);
          }
        }
      }
    }

    const startObj = output.indexOf('{');
    const endObj = output.lastIndexOf('}');
    if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
      const candidate = output.substring(startObj, endObj + 1);
      if (process.env.PLANNER_DEBUG) {
        console.log(`[Planner] _extractJSON: 尝试解析 candidate (长度: ${candidate.length})`);
      }
      try {
        JSON.parse(candidate);
        if (process.env.PLANNER_DEBUG) {
          console.log('[Planner] _extractJSON: candidate 解析成功');
        }
        return candidate;
      } catch {
        const braceCount = (candidate.match(/[{}]/g) || []).length;
        if (braceCount > 2) {
          let depth = 0, validEnd = -1;
          for (let i = 0; i < candidate.length; i++) {
            if (candidate[i] === '{') depth++;
            else if (candidate[i] === '}') {
              depth--;
              if (depth === 0) { validEnd = i; break; }
            }
          }
          if (validEnd > 0) {
            const trimmed = candidate.substring(0, validEnd + 1);
            try {
              JSON.parse(trimmed);
              if (process.env.PLANNER_DEBUG) {
                console.log('[Planner] _extractJSON: trimmed 解析成功');
              }
              return trimmed;
            } catch { /* ignore */ }
          }
        }
      }
    }

    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        JSON.parse(jsonMatch[0]);
        if (process.env.PLANNER_DEBUG) {
          console.log('[Planner] _extractJSON: jsonMatch 解析成功');
        }
        return jsonMatch[0];
      } catch { /* ignore */ }
    }

    if (process.env.PLANNER_DEBUG) {
      console.log('[Planner] _extractJSON: 所有解析方法都失败，返回原始字符串');
      console.log('[Planner] _extractJSON: 原始输出前 500 字符:', output.substring(0, 500));
    }

    return output;
  }

  _finalizePlan(planObj, requirement) {
    const planId = `plan_${Date.now()}`;
    
    const validatedPlan = {
      plan_id: planId,
      created_at: new Date().toISOString(),
      requirement,
      project: this._validateProject(planObj.project),
      features: this._validateFeatures(planObj.features),
      tasks: this._normalizeTasks(planObj.tasks || []),
      milestones: this._validateMilestones(planObj.milestones || []),
      metadata: {
        total_tasks: planObj.tasks?.length || 0,
        estimated_tokens: (planObj.tasks || []).reduce((sum, t) => sum + (t.estimated_tokens || 2000), 0),
        total_minutes_estimate: (planObj.tasks || []).reduce((sum, t) => sum + (t.estimated_minutes || 10), 0)
      }
    };

    this._ensureTaskDependencies(validatedPlan);
    
    return validatedPlan;
  }

  /**
   * 验证和规范化项目信息
   * @private
   */
  _validateProject(project) {
    if (!project || typeof project !== 'object') {
      return { name: 'unknownProject', description: '未命名项目' };
    }
    return {
      name: project.name || 'unknownProject',
      description: project.description || ''
    };
  }

  /**
   * 验证特性列表
   * @private
   */
  _validateFeatures(features) {
    if (!Array.isArray(features)) return [];
    return features.filter(f => typeof f === 'string' && f.length > 0).slice(0, 10);
  }

  /**
   * 规范化任务列表
   * @private
   */
  _normalizeTasks(tasks) {
    const validTypes = ['architect', 'create', 'modify', 'test', 'integrate', 'deploy', 'docs'];
    
    return tasks.map((task, index) => ({
      id: task.id || `t${index + 1}`,
      description: task.description || `任务 ${index + 1}`,
      type: validTypes.includes(task.type) ? task.type : 'create',
      dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
      agent: task.agent || 'native-coder',
      estimated_tokens: task.estimated_tokens || 2000,
      estimated_minutes: task.estimated_minutes || 10,
      files: Array.isArray(task.files) ? task.files : []
    }));
  }

  /**
   * 验证和规范化里程碑
   * @private
   */
  _validateMilestones(milestones) {
    return milestones.map((ms, index) => ({
      id: ms.id || `m${index + 1}`,
      name: ms.name || `里程碑 ${index + 1}`,
      tasks: Array.isArray(ms.tasks) ? ms.tasks : [],
      deliverables: Array.isArray(ms.deliverables) ? ms.deliverables : []
    }));
  }

  /**
   * 确保任务依赖关系正确
   * @private
   */
  _ensureTaskDependencies(plan) {
    const taskIds = new Set(plan.tasks.map(t => t.id));
    
    for (const task of plan.tasks) {
      task.dependencies = task.dependencies.filter(depId => taskIds.has(depId));
    }

    for (const milestone of plan.milestones) {
      milestone.tasks = milestone.tasks.filter(taskId => taskIds.has(taskId));
    }
  }

  _generateFallbackPlan(requirement) {
    console.log('[Planner] 🔧 使用规则分析引擎...');
    
    const analysis = this._analyze(requirement);
    const tasks = this._decompose(analysis);
    const milestones = this._createMilestones(tasks);

    const plan = {
      plan_id: `plan_${Date.now()}`,
      created_at: new Date().toISOString(),
      requirement,
      project: { name: analysis.name, description: requirement },
      features: analysis.features,
      milestones,
      tasks,
      metadata: {
        total_tasks: tasks.length,
        estimated_tokens: tasks.reduce((sum, t) => sum + (t.estimated_tokens || 2000), 0),
        total_minutes_estimate: tasks.reduce((sum, t) => sum + (t.estimated_minutes || 10), 0)
      }
    };

    console.log(`[Planner] 📋 规则分析完成:`);
    console.log(`[Planner]   - 项目类型: ${analysis.type}`);
    console.log(`[Planner]   - 检测到特性: ${analysis.features.join(', ') || '无'}`);
    console.log(`[Planner]   - 生成任务: ${tasks.length} 个`);
    
    return plan;
  }

  _analyze(requirement) {
    const lower = requirement.toLowerCase();
    const words = requirement.split(/\s+/);
    let name = words.slice(0, 3).join('');

    let type = this._detectProjectType(lower);
    name = this._generateProjectName(name, type, words);

    const features = this._extractFeatures(lower);

    return { name, type, features, raw: requirement };
  }

  /**
   * 检测项目类型
   * @private
   */
  _detectProjectType(lower) {
    const typePatterns = {
      blog: /博客|blog/i,
      ecommerce: /商城|shop|store|电商/i,
      forum: /论坛|forum|社区/i,
      admin: /管理|admin|后台/i,
      api: /api|接口|rest|graphql/i,
      upgrade: /升级|update|优化|refactor/i,
      migration: /迁移|migrate|搬迁/i,
      chat: /聊天|chat|即时通讯|im/i,
      video: /视频|video|直播|streaming/i,
      mobile: /小程序|miniprogram|微信|app|移动端/i
    };

    for (const [type, pattern] of Object.entries(typePatterns)) {
      if (pattern.test(lower)) return type;
    }
    return 'general';
  }

  /**
   * 生成项目名称
   * @private
   */
  _generateProjectName(name, type, words) {
    const typeNameMap = {
      blog: 'blogProject',
      ecommerce: 'shopSystem',
      forum: 'forumCommunity',
      admin: 'adminPanel',
      api: 'apiService',
      upgrade: 'upgradeProject',
      migration: 'migrateProject',
      chat: 'chatApp',
      video: 'videoPlatform',
      mobile: 'mobileApp'
    };

    if (type !== 'general' && typeNameMap[type]) {
      return typeNameMap[type];
    }
    return name || 'myProject';
  }

  /**
   * 提取项目特性
   * @private
   */
  _extractFeatures(lower) {
    const featureKeywords = {
      '用户认证': /用户|登录|注册|login|register|signup|signin|auth/i,
      '内容管理': /文章|内容|post|article|内容管理/i,
      '评论功能': /评论|comment|feedback|留言/i,
      '支付功能': /支付|pay|payment|购买|订单/i,
      '搜索功能': /搜索|search|查询|find/i,
      '权限管理': /权限|role|permission|admin|授权/i,
      '消息通知': /消息|通知|notification|msg|email|短信/i,
      '文件上传': /上传|upload|文件|file|图片|img|avatar/i,
      '数据统计': /统计|analytics|dashboard|图表|chart|数据/i,
      '社交功能': /关注|follow|粉丝|friends|社交|分享|share/i
    };

    const features = [];
    for (const [feature, pattern] of Object.entries(featureKeywords)) {
      if (pattern.test(lower)) {
        features.push(feature);
      }
    }
    return features;
  }

  _decompose(analysis) {
    const tasks = [];
    let taskId = 1;
    const features = analysis.features.length > 0 ? analysis.features : ['基础功能'];

    tasks.push({
      id: `t${taskId++}`,
      description: '初始化项目结构和技术栈',
      type: 'architect',
      dependencies: [],
      agent: 'native-coder',
      estimated_tokens: 2000,
      estimated_minutes: 10
    });

    tasks.push({
      id: `t${taskId++}`,
      description: '搭建基础框架和核心模块结构',
      type: 'create',
      dependencies: [`t${taskId - 2}`],
      agent: 'native-coder',
      estimated_tokens: 3000,
      estimated_minutes: 15
    });

    const featureTaskIds = [];
    for (const feature of features) {
      const currentId = `t${taskId++}`;
      featureTaskIds.push(currentId);
      tasks.push({
        id: currentId,
        description: `实现${feature}功能模块`,
        type: 'create',
        dependencies: [`t${taskId - 2}`],
        agent: 'native-coder',
        estimated_tokens: 2500,
        estimated_minutes: 12
      });
    }

    tasks.push({
      id: `t${taskId++}`,
      description: '功能模块集成和联调测试',
      type: 'integrate',
      dependencies: featureTaskIds,
      agent: 'native-coder',
      estimated_tokens: 2000,
      estimated_minutes: 10
    });

    tasks.push({
      id: `t${taskId++}`,
      description: '部署配置、性能优化和安全加固',
      type: 'deploy',
      dependencies: [`t${taskId - 2}`],
      agent: 'native-coder',
      estimated_tokens: 1500,
      estimated_minutes: 8
    });

    tasks.push({
      id: `t${taskId++}`,
      description: '编写单元测试、集成测试和用户文档',
      type: 'test',
      dependencies: [`t${taskId - 2}`],
      agent: 'native-coder',
      estimated_tokens: 1000,
      estimated_minutes: 5
    });

    return tasks;
  }

  _createMilestones(tasks) {
    const milestones = [
      { id: 'm1', name: '基础框架搭建', tasks: [], phase: 1 },
      { id: 'm2', name: '核心功能开发', tasks: [], phase: 2 },
      { id: 'm3', name: '模块集成测试', tasks: [], phase: 3 },
      { id: 'm4', name: '部署与上线', tasks: [], phase: 4 }
    ];

    for (const task of tasks) {
      const taskNum = parseInt(task.id.replace('t', ''));
      
      if (taskNum <= 2) {
        milestones[0].tasks.push(task.id);
      } else if (task.type === 'integrate') {
        milestones[2].tasks.push(task.id);
      } else if (task.type === 'test' || task.type === 'deploy') {
        milestones[3].tasks.push(task.id);
      } else {
        milestones[1].tasks.push(task.id);
      }
    }

    return milestones.filter(m => m.tasks.length > 0);
  }

  _generateTimestampFilename() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `plan_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
  }

  /**
   * 保存计划到文件
   */
  async savePlan(plan, filename, output_path) {
    const resolved_output_path = output_path || this.projectRoot || process.cwd();
    const resolved_filename = filename || this._generateTimestampFilename();

    await fs.mkdir(resolved_output_path, { recursive: true });

    const filepath = path.join(resolved_output_path, resolved_filename);
    await fs.writeFile(filepath, JSON.stringify(plan, null, 2), 'utf-8');

    console.log(`[Planner] 计划已保存: ${filepath}`);
    return { filepath, filename: resolved_filename };
  }
}
