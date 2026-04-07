import { AgentAdapter } from './base.js';
import { MultiAgentThinker } from '../thinker.js';
import { ProjectStateProbe } from '../convergence/project-state-probe.js';

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
    this.stateProbe = new ProjectStateProbe(config.state_probe || {});
  }

  async healthCheck() {
    return Boolean(process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY || this.api_key);
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

    const baseContextPrompt = `项目根目录: ${projectRoot}
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
${requirement}`;

    const draftPrompt = `${baseContextPrompt}

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

    const draftRawOutput = await thinker._callAgent('Rainmaker', systemPrompt, draftPrompt, 0.2);
    const draftPlan = this._extractJSON(draftRawOutput);

    if (!draftPlan || !Array.isArray(draftPlan.tasks) || draftPlan.tasks.length === 0) {
      throw new Error('Rainmaker 草案不可解析或任务为空');
    }

    const probe = await this._runStateProbeReplan({
      projectRoot,
      requirement,
      draftPlan,
    });

    let finalPlan = draftPlan;
    let finalRawOutput = draftRawOutput;
    if (probe?.decisions?.some((item) => item.action === 'probe_replan')) {
      const replanPrompt = this._buildProbeReplanPrompt({
        requirement,
        draftPlan,
        probe,
      });
      const replanRawOutput = await thinker._callAgent('Rainmaker', systemPrompt, replanPrompt, 0.2);
      const replanned = this._extractJSON(replanRawOutput);
      if (replanned && Array.isArray(replanned.tasks) && replanned.tasks.length > 0) {
        finalPlan = this._mergeProbeMetadataIntoPlan(replanned, probe, requirement);
        finalRawOutput = replanRawOutput;
      } else {
        finalPlan = this._mergeProbeMetadataIntoPlan(draftPlan, probe, requirement);
      }
    } else {
      finalPlan = this._mergeProbeMetadataIntoPlan(draftPlan, probe, requirement);
    }

    return this._formatResult(
      {
        task_id: task.id || 'rainmaker_audit',
        success: true,
        plan: finalPlan,
        summary: finalPlan.audit?.summary || 'Rainmaker 巡检完成',
        findings: finalPlan.audit?.findings || [],
        raw_output: finalRawOutput,
        probe,
        planning_stages: {
          draft_generated: true,
          probe_replanned: probe?.decisions?.some((item) => item.action === 'probe_replan') || false,
        },
        duration_ms: Date.now() - startTime,
      },
      startTime,
    );
  }

  async _runStateProbeReplan({ projectRoot, requirement, draftPlan }) {
    const snapshot = await this.stateProbe.collectProjectState(projectRoot);
    const decisions = [];
    const tasks = Array.isArray(draftPlan?.tasks) ? draftPlan.tasks : [];
    for (const task of tasks) {
      const probeResult = await this.stateProbe.evaluateTaskState(
        {
          ...task,
          description: task.description || requirement,
        },
        projectRoot,
      );
      if (!probeResult.already_satisfied && (probeResult.missing_artifacts || []).length > 0) {
        decisions.push({
          task_id: task.id,
          action: 'probe_replan',
          reason: probeResult.reason,
          missing_artifacts: probeResult.missing_artifacts || [],
          required_artifacts: probeResult.required_artifacts || [],
        });
      } else {
        decisions.push({
          task_id: task.id,
          action: probeResult.already_satisfied ? 'task_already_satisfied' : 'keep_as_is',
          reason: probeResult.reason,
          missing_artifacts: probeResult.missing_artifacts || [],
          required_artifacts: probeResult.required_artifacts || [],
        });
      }
    }

    return {
      mode: 'state_probe_replan',
      project_state: {
        captured_at: snapshot.captured_at,
        top_level_files: snapshot.files.length,
        top_level_directories: snapshot.directories.length,
      },
      decisions,
    };
  }

  _buildProbeReplanPrompt({ requirement, draftPlan, probe }) {
    const decisions = Array.isArray(probe?.decisions) ? probe.decisions : [];
    const missingDecisionLines = decisions
      .filter((d) => d.action === 'probe_replan')
      .slice(0, 12)
      .map(
        (d, idx) =>
          `${idx + 1}. 任务 ${d.task_id}: 缺失工件 ${d.missing_artifacts.join(', ') || 'unknown'}`,
      )
      .join('\n');

    return `你将基于状态探针结果对“已有草案计划”重订，不允许偏离业务目标。

## 业务目标
${requirement}

## 状态探针结论
- 采样时间: ${probe?.project_state?.captured_at || 'unknown'}
- 顶层文件数: ${probe?.project_state?.top_level_files ?? 0}
- 顶层目录数: ${probe?.project_state?.top_level_directories ?? 0}
- 需要重订的任务:
${missingDecisionLines || '无'}

## 已有草案计划(JSON)
${JSON.stringify(draftPlan, null, 2)}

## 重订要求
1. 优先补齐状态探针识别的缺失工件
2. 必须保持“目标不变、路径可变”
3. 对需重订任务，设置 execution_mode="probe_replan"，并写入 replan_plan
4. 仍按 runability -> pitfall -> optimization 顺序组织任务
5. 输出必须是合法 JSON，不要带 Markdown

请输出完整新计划 JSON。`;
  }

  _mergeProbeMetadataIntoPlan(plan, probe, requirement) {
    const merged = { ...(plan || {}) };
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const decisionMap = new Map(
      (probe?.decisions || []).map((item) => [String(item.task_id), item]),
    );

    merged.tasks = tasks.map((task) => {
      const decision = decisionMap.get(String(task.id));
      if (!decision || decision.action !== 'probe_replan') {
        return task;
      }
      const missing = decision.missing_artifacts || [];
      const replanPlan = task.replan_plan || {
        strategy: 'rainmaker_probe_replan',
        goal: requirement,
        missing_artifacts: missing,
        phases: [
          { name: 'state_probe', objective: '基于状态探针确认缺失工件与可复用资产' },
          {
            name: 'gap_fill',
            objective: `补齐缺失工件: ${missing.join(', ') || 'unknown'}`,
          },
          { name: 'goal_resume', objective: '补洞后回归原任务目标，验证目标一致性' },
        ],
      };
      const subtasks = Array.isArray(task.subtasks) ? [...task.subtasks] : [];
      subtasks.push('执行阶段1: 状态探针确认缺失与可复用资产');
      subtasks.push(`执行阶段2: 补齐缺失工件 ${missing.join(', ') || 'unknown'}`);
      subtasks.push('执行阶段3: 回归原目标并验证目标一致性');

      return {
        ...task,
        goal: task.goal || requirement,
        execution_mode: task.execution_mode || 'probe_replan',
        replan_plan: replanPlan,
        subtasks,
      };
    });

    merged.probe = probe || null;
    return merged;
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
        probe: rawResult.probe || null,
        planning_stages: rawResult.planning_stages || null,
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
