/**
 * Planner - 自然语言需求 → 执行计划
 */

const fs = require('fs').promises;
const path = require('path');
const { AgentDispatcher } = require('./agents/dispatcher');
const { ClaudeCodeAdapter } = require('./agents/claude-code');
const { MinimaxMCPAdapter } = require('./agents/minimax-mcp');
const { config } = require('../config');

class Planner {
  constructor(configOverrides = {}) {
    this.config = { ...config, ...configOverrides };
    this.projectRoot = this.config.project_root || process.cwd();
    // 实例化分发器以供 AI 分析使用
    this.dispatcher = new AgentDispatcher({
      ...this.config.dispatcher,
      ...(this.config.agents?.opencode || {}),
      ...(this.config.agents?.['claude-code'] || {})
    });
    this.dispatcher.registerAgent('claude-code', new ClaudeCodeAdapter({
      ...this.config.agents?.['claude-code'],
      ...configOverrides
    }));
    this.dispatcher.registerAgent('minimax-mcp', new MinimaxMCPAdapter({
      ...this.config.agents?.['minimax-mcp'],
      ...configOverrides
    }));
  }

  /**
   * 从自然语言生成执行计划
   * @param {string} requirement - 自然语言需求
   * @returns {Promise<Object>} 执行计划
   */
  async plan(requirement) {
    console.log(`[Planner] 利用 AI 开始深度分析需求: "${requirement}"`);

    const prompt = `你是一个资深的软件架构师。请深入分析以下项目需求，并严格输出一个 JSON 格式的任务分解计划。
不要包含任何多余的 Markdown 或闲聊文字。此输出将直接被程序解析。

# 需求描述:
${requirement}

# 必须遵循的输出格式:
{
  "project": { "name": "项目英文短名称", "description": "一句话核心介绍" },
  "features": ["特性1", "特性2", "特性3"],
  "tasks": [
    {
      "id": "t1",
      "description": "具体的开发阶段或实现任务",
      "type": "architect", // 可选值: architect, create, integrate, test 等
      "dependencies": [], // 此任务依赖的前置任务 id 列表
      "agent": "claude-code",
      "estimated_tokens": 2000,
      "estimated_minutes": 15
    }
  ],
  "milestones": [
    { "id": "m1", "name": "基础框架阶段", "tasks": ["t1", "t2"] }
  ]
}`;

    try {
      // 1. 调用选定的 AI 分析策略
      const plannerAgentName = this.config.planner_agent || 'claude-code';
      
      const agentResult = await this.dispatcher.dispatch({
        id: 'plan_analysis',
        type: 'analysis',
        // claude-code 使用组装好的 prompt，minimax 使用原始 requirement 并在内部重组
        description: plannerAgentName === 'claude-code' ? prompt : requirement,
        agent: plannerAgentName, // 优先调度该 agent
        context: { project_root: this.projectRoot }
      });

      // 2. 提取并验证 JSON
      const content = this._extractJSON(
        agentResult.output?.raw_output || 
        agentResult.output?.review_report || 
        agentResult.result || 
        String(agentResult)
      );
      
      const parsedPlan = JSON.parse(content);
      return this._finalizePlan(parsedPlan, requirement);
    } catch (e) {
      console.log(`[Planner] ⚠️ AI 需求分析失败 (${e.message})，回退到规则分析模式...`);
      return this._generateFallbackPlan(requirement);
    }
  }

  _extractJSON(output) {
    if (typeof output !== 'string') return JSON.stringify(output);
    
    const codeBlocks = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
    for (const match of codeBlocks) {
      try {
        const parsed = JSON.parse(match[1].trim());
        return JSON.stringify(parsed);
      } catch (e) { /* ignore */ }
    }
    
    const startObj = output.indexOf('{');
    const endObj = output.lastIndexOf('}');
    if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
      const candidate = output.substring(startObj, endObj + 1);
      try {
        const parsed = JSON.parse(candidate);
        return JSON.stringify(parsed);
      } catch (e) { /* ignore */ }
    }
    
    return output;
  }

  _finalizePlan(planObj, requirement) {
    planObj.plan_id = `plan_${Date.now()}`;
    planObj.created_at = new Date().toISOString();
    planObj.requirement = requirement;
    
    planObj.metadata = {
      total_tasks: planObj.tasks?.length || 0,
      estimated_tokens: (planObj.tasks || []).reduce((sum, t) => sum + (t.estimated_tokens || 1000), 0),
      total_minutes_estimate: (planObj.tasks || []).reduce((sum, t) => sum + (t.estimated_minutes || 5), 0)
    };
    
    return planObj;
  }

  _generateFallbackPlan(requirement) {
    // 1. 理解需求，提取关键信息
    const analysis = this._analyze(requirement);
    // 2. 拆解任务
    const tasks = this._decompose(analysis);
    // 3. 生成分阶段里程碑
    const milestones = this._createMilestones(tasks);

    return {
      plan_id: `plan_${Date.now()}`,
      created_at: new Date().toISOString(),
      requirement,
      project: {
        name: analysis.name,
        description: requirement
      },
      milestones,
      tasks,
      metadata: {
        total_tasks: tasks.length,
        estimated_tokens: tasks.reduce((sum, t) => sum + (t.estimated_tokens || 1000), 0),
        total_minutes_estimate: tasks.reduce((sum, t) => sum + (t.estimated_minutes || 5), 0)
      }
    };
  }

  /**
   * 分析需求
   * @private
   */
  _analyze(requirement) {
    const lower = requirement.toLowerCase();

    // 提取项目名称（第一个关键名词）
    const words = requirement.split(/\s+/);
    let name = words.slice(0, 3).join('');

    // 判断项目类型
    let type = 'general';
    if (lower.includes('博客') || lower.includes('blog')) type = 'blog';
    if (lower.includes('商城') || lower.includes('shop') || lower.includes('store')) type = 'ecommerce';
    if (lower.includes('论坛') || lower.includes('forum')) type = 'forum';
    if (lower.includes('管理') || lower.includes('admin')) type = 'admin';
    if (lower.includes('api') || lower.includes('接口')) type = 'api';
    if (lower.includes('升级') || lower.includes('update') || lower.includes('优化')) type = 'upgrade';
    if (lower.includes('迁移') || lower.includes('migrate')) type = 'migration';

    // 判断关键词
    const features = [];
    if (lower.includes('用户') || lower.includes('登录') || lower.includes('注册')) features.push('用户认证');
    if (lower.includes('文章') || lower.includes('post')) features.push('内容管理');
    if (lower.includes('评论') || lower.includes('comment')) features.push('评论功能');
    if (lower.includes('支付') || lower.includes('pay')) features.push('支付');
    if (lower.includes('搜索') || lower.includes('search')) features.push('搜索');
    if (lower.includes('权限') || lower.includes('role') || lower.includes('permission')) features.push('权限管理');
    if (lower.includes('消息') || lower.includes('通知') || lower.includes('notification')) features.push('通知');

    return { name, type, features, raw: requirement };
  }

  /**
   * 拆解任务
   * @private
   */
  _decompose(analysis) {
    const tasks = [];
    let taskId = 1;

    // 根据项目类型和功能生成任务
    const features = analysis.features.length > 0 ? analysis.features : ['基础功能'];

    // 阶段 1: 基础框架
    tasks.push({
      id: `t${taskId++}`,
      description: '初始化项目结构和技术栈',
      type: 'architect',
      dependencies: [],
      agent: 'claude-code',
      estimated_tokens: 2000,
      estimated_minutes: 10
    });

    tasks.push({
      id: `t${taskId++}`,
      description: '搭建基础框架和模块结构',
      type: 'create',
      dependencies: [`t${taskId - 2}`],
      agent: 'claude-code',
      estimated_tokens: 3000,
      estimated_minutes: 15
    });

    // 阶段 2: 功能模块
    const featureTaskIds = [];
    for (const feature of features) {
      const currentId = `t${taskId++}`;
      featureTaskIds.push(currentId);
      tasks.push({
        id: currentId,
        description: `实现${feature}功能`,
        type: 'create',
        dependencies: [`t${taskId - 2}`],
        agent: 'claude-code',
        estimated_tokens: 2500,
        estimated_minutes: 12
      });
    }

    // 阶段 3: 集成和优化
    tasks.push({
      id: `t${taskId++}`,
      description: '功能集成和联调测试',
      type: 'integrate',
      dependencies: featureTaskIds,
      agent: 'claude-code',
      estimated_tokens: 2000,
      estimated_minutes: 10
    });

    // 阶段 4: 上线准备
    tasks.push({
      id: `t${taskId++}`,
      description: '部署配置和性能优化',
      type: 'create',
      dependencies: [`t${taskId - 2}`],
      agent: 'claude-code',
      estimated_tokens: 1500,
      estimated_minutes: 8
    });

    tasks.push({
      id: `t${taskId++}`,
      description: '编写测试和文档',
      type: 'test',
      dependencies: [`t${taskId - 2}`],
      agent: 'claude-code',
      estimated_tokens: 1000,
      estimated_minutes: 5
    });

    return tasks;
  }

  /**
   * 创建里程碑
   * @private
   */
  _createMilestones(tasks) {
    const milestones = [
      { id: 'm1', name: '基础框架', tasks: [], phase: 1 },
      { id: 'm2', name: '功能开发', tasks: [], phase: 2 },
      { id: 'm3', name: '集成测试', tasks: [], phase: 3 },
      { id: 'm4', name: '上线准备', tasks: [], phase: 4 }
    ];

    // 根据任务 ID 分配里程碑
    for (const task of tasks) {
      const taskNum = parseInt(task.id.replace('t', ''));
      if (taskNum <= 2) {
        milestones[0].tasks.push(task.id);
      } else if (task.type === 'integrate') {
        milestones[2].tasks.push(task.id);
      } else if (task.type === 'test' || (task.type === 'create' && task.description.includes('部署'))) {
        milestones[3].tasks.push(task.id);
      } else {
        milestones[1].tasks.push(task.id);
      }
    }

    // 清理空里程碑
    return milestones.filter(m => m.tasks.length > 0);
  }

  /**
   * 生成带时间戳的计划文件名
   * @private
   * @returns {string} 文件名格式: plan_YYYYMMDD_HHMMSS.json
   */
  _generateTimestampFilename() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `plan_${year}${month}${day}_${hours}${minutes}${seconds}.json`;
  }

  /**
   * 保存计划到文件
   * @param {Object} plan - 执行计划对象
   * @param {string} [filename] - 文件名（可选，默认自动生成带时间戳的文件名）
   * @param {string} [output_path] - 输出目录路径（可选，默认当前目录）
   * @returns {Promise<{filepath: string, filename: string}>} 保存结果，包含完整路径和文件名
   */
  async savePlan(plan, filename, output_path) {
    // 使用提供的输出路径或默认当前目录
    const resolved_output_path = output_path || this.projectRoot || process.cwd();
    
    // 生成文件名：使用提供的名称或自动生成带时间戳的名称
    const resolved_filename = filename || this._generateTimestampFilename();
    
    // 确保输出目录存在
    await fs.mkdir(resolved_output_path, { recursive: true });

    // 拼接完整文件路径
    const filepath = path.join(resolved_output_path, resolved_filename);
    await fs.writeFile(filepath, JSON.stringify(plan, null, 2), 'utf-8');

    console.log(`[Planner] 计划已保存: ${filepath}`);
    
    // 返回完整路径和文件名，便于调用方使用
    return {
      filepath,
      filename: resolved_filename
    };
  }
}

module.exports = { Planner };
