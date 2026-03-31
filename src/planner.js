/**
 * Planner - 自然语言需求 → 执行计划
 */

const fs = require('fs').promises;
const path = require('path');

class Planner {
  constructor(config = {}) {
    this.config = config;
    this.projectRoot = config.project_root || process.cwd();
  }

  /**
   * 从自然语言生成执行计划
   * @param {string} requirement - 自然语言需求
   * @returns {Promise<Object>} 执行计划
   */
  async plan(requirement) {
    console.log(`[Planner] 分析需求: "${requirement}"`);

    // 1. 理解需求，提取关键信息
    const analysis = this._analyze(requirement);
    console.log(`[Planner] 分析完成: ${analysis.type}`);

    // 2. 拆解任务
    const tasks = this._decompose(analysis);
    console.log(`[Planner] 任务拆解: ${tasks.length} 个任务`);

    // 3. 生成分阶段里程碑
    const milestones = this._createMilestones(tasks);
    console.log(`[Planner] 里程碑: ${milestones.length} 个阶段`);

    // 4. 生成计划
    const plan = {
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

    return plan;
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
    for (const feature of features) {
      tasks.push({
        id: `t${taskId++}`,
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
      dependencies: features.map((_, i) => `t${taskId - features.length + i}`),
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
      } else if (task.phase === 'integrate') {
        milestones[2].tasks.push(task.id);
      } else if (task.type === 'test' || task.type === 'create' && task.description.includes('部署')) {
        milestones[3].tasks.push(task.id);
      } else {
        milestones[1].tasks.push(task.id);
      }
    }

    // 清理空里程碑
    return milestones.filter(m => m.tasks.length > 0);
  }

  /**
   * 保存计划到文件
   * @param {Object} plan
   * @param {string} filename
   */
  async savePlan(plan, filename) {
    const plansDir = path.join(this.projectRoot, 'plans');
    await fs.mkdir(plansDir, { recursive: true });

    const filepath = path.join(plansDir, filename);
    await fs.writeFile(filepath, JSON.stringify(plan, null, 2), 'utf-8');

    console.log(`[Planner] 计划已保存: ${filepath}`);
    return filepath;
  }
}

module.exports = { Planner };
