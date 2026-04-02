import { AgentAdapter } from './base.js';
import { MultiAgentThinker } from '../thinker.js';
import { jsonrepair } from 'jsonrepair';

const RAINMAKER_CONFIG = {
  name: 'rainmaker',
  type: 'api',
  capabilities: ['project-audit', 'workflow-planning', 'stability-hardening'],
};

export class RainmakerAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...RAINMAKER_CONFIG, ...config });
    this.model = config.model;
    this.api_key = config.api_key;
    this.api_host = config.api_host;
  }

  async healthCheck() {
    return Boolean(process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY || this.api_key);
  }

  _extractJSON(output) {
    if (typeof output !== 'string') return output;

    const withoutThink = output.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const codeBlocks = [...withoutThink.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];

    for (const match of codeBlocks) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        try {
          return JSON.parse(jsonrepair(match[1].trim()));
        } catch {
          // ignore
        }
      }
    }

    const firstBrace = withoutThink.indexOf('{');
    const lastBrace = withoutThink.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const candidate = withoutThink.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        try {
          return JSON.parse(jsonrepair(candidate));
        } catch {
          // ignore
        }
      }
    }

    try {
      return JSON.parse(jsonrepair(withoutThink));
    } catch {
      return null;
    }
  }

  async execute(task) {
    const startTime = Date.now();
    const projectRoot = task.context?.project_root || process.cwd();
    const context = await this.getProjectContext(projectRoot);
    const requirement =
      task.description ||
      `对项目 ${projectRoot} 做全局巡检并生成修复优化计划，按“能跑 > 防坑 > 优化”分级`;

    const thinker = new MultiAgentThinker({
      model: this.model,
      api_key: this.api_key,
      api_host: this.api_host,
      verbose: false,
    });

    const systemPrompt = `你是 Rainmaker，专门负责对已有项目做全局运行逻辑巡检，并输出可执行修复计划。
必须遵守优先级：
1. 能跑（启动、构建、核心流程可执行）
2. 防坑（崩溃、死循环、重复修复、阻塞退出、安全风险）
3. 优化（性能、可维护性、代码质量）
输出必须是合法 JSON，不要输出任何多余文本。`;

    const userPrompt = `项目根目录: ${projectRoot}
项目文件概览:
${context.structure || 'unknown'}

顶层文件:
${(context.files || []).slice(0, 30).join(', ') || 'none'}

技术栈:
${context.packageJson ? JSON.stringify({
      name: context.packageJson.name,
      type: context.packageJson.type,
      scripts: context.packageJson.scripts || {},
      dependencies: Object.keys(context.packageJson.dependencies || {}).slice(0, 20),
    }) : context.techStack || 'unknown'}

任务目标:
${requirement}

按以下 JSON 结构输出:
{
  "project": {
    "name": "string",
    "description": "string"
  },
  "features": ["string"],
  "audit": {
    "runability_score": 0,
    "pitfall_score": 0,
    "optimization_score": 0,
    "summary": "string",
    "findings": [
      {
        "level": "P0|P1|P2|P3",
        "stage": "runability|pitfall|optimization",
        "title": "string",
        "reason": "string",
        "suggestion": "string"
      }
    ]
  },
  "tasks": [
    {
      "id": "t1",
      "description": "string",
      "type": "architect|create|modify|test|integrate|deploy|docs",
      "dependencies": [],
      "agent": "native-coder",
      "estimated_tokens": 2000,
      "estimated_minutes": 10
    }
  ],
  "milestones": [
    {
      "id": "m1",
      "name": "先能跑",
      "tasks": ["t1"]
    }
  ]
}

要求:
- 必须至少输出 3 个任务
- 任务顺序必须先覆盖 runability，再 pitfall，最后 optimization
- 若审查发现高危问题，优先生成修复任务，不要先做优化`;

    const rawOutput = await thinker._callAgent('Rainmaker', systemPrompt, userPrompt, 0.2);
    const parsed = this._extractJSON(rawOutput);

    if (!parsed || !Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      throw new Error('Rainmaker 输出不可解析或任务为空');
    }

    return this._formatResult(
      {
        task_id: task.id || 'rainmaker_audit',
        success: true,
        plan: parsed,
        summary: parsed.audit?.summary || 'Rainmaker 巡检完成',
        findings: parsed.audit?.findings || [],
        raw_output: rawOutput,
        duration_ms: Date.now() - startTime,
      },
      startTime,
    );
  }

  _formatResult(rawResult, startTime) {
    return {
      task_id: rawResult.task_id || 'rainmaker_audit',
      agent: this.name,
      status: rawResult.success ? 'success' : 'failed',
      output: {
        plan: rawResult.plan || null,
        summary: rawResult.summary || '',
        findings: rawResult.findings || [],
        raw_output: rawResult.raw_output || '',
      },
      metrics: {
        duration_ms: rawResult.duration_ms || Date.now() - startTime,
        tokens_used: rawResult.tokens_used || 0,
      },
      errors: rawResult.errors || [],
    };
  }
}

export default RainmakerAdapter;
