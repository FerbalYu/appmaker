/**
 * Planner - 自然语言需求 → 执行计划
 */

import { promises as fs } from 'fs';
import path from 'path';
import { AgentDispatcher } from './agents/dispatcher.js';
import { NativeCoderAdapter } from './agents/native-coder.js';
import { MinimaxMCPAdapter } from './agents/minimax-mcp.js';
import { config } from '../config/index.js';

export class Planner {
  constructor(configOverrides = {}) {
    this.config = { ...config, ...configOverrides };
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
  }

  /**
   * 从自然语言生成执行计划
   * @param {string} requirement
   * @returns {Promise<Object>}
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
      "type": "architect",
      "dependencies": [],
      "agent": "native-coder",
      "estimated_tokens": 2000,
      "estimated_minutes": 15
    }
  ],
  "milestones": [
    { "id": "m1", "name": "基础框架阶段", "tasks": ["t1", "t2"] }
  ]
}`;

    const startTime = Date.now();
    const spinner = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`[Planner] AI 大脑高速运转中... (已耗时: ${elapsed}s)`);
    }, 2000);

    const plannerAgentName = this.config.planner_agent || 'native-coder';

    try {
      const agentResult = await this.dispatcher.dispatch({
        id: 'plan_analysis',
        type: 'analysis',
        description: plannerAgentName === 'native-coder' ? prompt : requirement,
        agent: plannerAgentName,
        context: { project_root: this.projectRoot }
      });

      clearInterval(spinner);
      process.stdout.write('\r' + ' '.repeat(70) + '\r');

      const content = this._extractJSON(
        agentResult.output?.raw_output ||
        agentResult.output?.summary ||
        agentResult.output?.review_report ||
        agentResult.result ||
        String(agentResult)
      );

      const parsedPlan = JSON.parse(content);
      return this._finalizePlan(parsedPlan, requirement);
    } catch (e) {
      clearInterval(spinner);
      process.stdout.write('\r' + ' '.repeat(70) + '\r');

      console.log(`[Planner] \x1b[33m⚠️ AI 需求分析失败 (${e.message})，回退到规则分析模式...\x1b[0m`);

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
      } catch { /* ignore */ }
    }
    
    const startObj = output.indexOf('{');
    const endObj = output.lastIndexOf('}');
    if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
      const candidate = output.substring(startObj, endObj + 1);
      try {
        JSON.parse(candidate);
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
        return jsonMatch[0];
      } catch { /* ignore */ }
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
    const analysis = this._analyze(requirement);
    const tasks = this._decompose(analysis);
    const milestones = this._createMilestones(tasks);

    return {
      plan_id: `plan_${Date.now()}`,
      created_at: new Date().toISOString(),
      requirement,
      project: { name: analysis.name, description: requirement },
      milestones,
      tasks,
      metadata: {
        total_tasks: tasks.length,
        estimated_tokens: tasks.reduce((sum, t) => sum + (t.estimated_tokens || 1000), 0),
        total_minutes_estimate: tasks.reduce((sum, t) => sum + (t.estimated_minutes || 5), 0)
      }
    };
  }

  _analyze(requirement) {
    const lower = requirement.toLowerCase();
    const words = requirement.split(/\s+/);
    let name = words.slice(0, 3).join('');

    let type = 'general';
    if (lower.includes('博客') || lower.includes('blog')) type = 'blog';
    if (lower.includes('商城') || lower.includes('shop') || lower.includes('store')) type = 'ecommerce';
    if (lower.includes('论坛') || lower.includes('forum')) type = 'forum';
    if (lower.includes('管理') || lower.includes('admin')) type = 'admin';
    if (lower.includes('api') || lower.includes('接口')) type = 'api';
    if (lower.includes('升级') || lower.includes('update') || lower.includes('优化')) type = 'upgrade';
    if (lower.includes('迁移') || lower.includes('migrate')) type = 'migration';

    const typeNameMap = {
      blog: 'blogProject',
      ecommerce: 'shopSystem',
      forum: 'forum社区',
      admin: 'adminPanel',
      api: 'api服务',
      upgrade: 'upgradeProject',
      migration: 'migrateProject'
    };

    if (type !== 'general') {
      name = typeNameMap[type] || `${type}Project`;
    }

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

  _decompose(analysis) {
    const tasks = [];
    let taskId = 1;
    const features = analysis.features.length > 0 ? analysis.features : ['基础功能'];

    tasks.push({ id: `t${taskId++}`, description: '初始化项目结构和技术栈', type: 'architect', dependencies: [], agent: 'native-coder', estimated_tokens: 2000, estimated_minutes: 10 });
    tasks.push({ id: `t${taskId++}`, description: '搭建基础框架和模块结构', type: 'create', dependencies: [`t${taskId - 2}`], agent: 'native-coder', estimated_tokens: 3000, estimated_minutes: 15 });

    const featureTaskIds = [];
    for (const feature of features) {
      const currentId = `t${taskId++}`;
      featureTaskIds.push(currentId);
      tasks.push({ id: currentId, description: `实现${feature}功能`, type: 'create', dependencies: [`t${taskId - 2}`], agent: 'native-coder', estimated_tokens: 2500, estimated_minutes: 12 });
    }

    tasks.push({ id: `t${taskId++}`, description: '功能集成和联调测试', type: 'integrate', dependencies: featureTaskIds, agent: 'native-coder', estimated_tokens: 2000, estimated_minutes: 10 });
    tasks.push({ id: `t${taskId++}`, description: '部署配置和性能优化', type: 'create', dependencies: [`t${taskId - 2}`], agent: 'native-coder', estimated_tokens: 1500, estimated_minutes: 8 });
    tasks.push({ id: `t${taskId++}`, description: '编写测试和文档', type: 'test', dependencies: [`t${taskId - 2}`], agent: 'native-coder', estimated_tokens: 1000, estimated_minutes: 5 });

    return tasks;
  }

  _createMilestones(tasks) {
    const milestones = [
      { id: 'm1', name: '基础框架', tasks: [], phase: 1 },
      { id: 'm2', name: '功能开发', tasks: [], phase: 2 },
      { id: 'm3', name: '集成测试', tasks: [], phase: 3 },
      { id: 'm4', name: '上线准备', tasks: [], phase: 4 }
    ];

    for (const task of tasks) {
      const taskNum = parseInt(task.id.replace('t', ''));
      if (taskNum <= 2) milestones[0].tasks.push(task.id);
      else if (task.type === 'integrate') milestones[2].tasks.push(task.id);
      else if (task.type === 'test' || (task.type === 'create' && task.description.includes('部署'))) milestones[3].tasks.push(task.id);
      else milestones[1].tasks.push(task.id);
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
