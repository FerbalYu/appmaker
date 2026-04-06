import { promises as fs } from 'fs';
import path from 'path';

function toIso(ts) {
  return new Date(ts).toISOString();
}

export class ReleaseObserver {
  constructor(projectRoot, config = {}) {
    this.projectRoot = projectRoot || process.cwd();
    this.config = {
      enabled: false,
      observation_window_days: 7,
      auto_generate_report: true,
      ...config,
    };
    this.stateDir = path.join(this.projectRoot, '.ncf', 'ops');
    this.statePath = path.join(this.stateDir, 'release-observation.json');
    this.reportDir = path.join(this.projectRoot, '.ncf', 'reports');
  }

  async _loadState(now = Date.now()) {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const state = JSON.parse(raw);
      if (state?.window?.ends_at && Date.parse(state.window.ends_at) > now) {
        return state;
      }
    } catch {
      // ignore
    }

    const days = this.config.observation_window_days;
    const endsAt = now + days * 24 * 60 * 60 * 1000;
    return {
      window: {
        started_at: toIso(now),
        ends_at: toIso(endsAt),
        days,
      },
      runs: [],
      aggregates: {
        total_runs: 0,
        avg_tokens_per_success_task: 0,
        avg_duration_ms: 0,
        avg_wasted_token_ratio: 0,
        avg_repeat_issue_rate: 0,
      },
    };
  }

  _computeAggregates(runs = []) {
    const count = runs.length || 1;
    const sum = runs.reduce(
      (acc, run) => {
        acc.tokens += run.tokens_per_success_task || 0;
        acc.duration += run.duration_ms || 0;
        acc.wasted += run.wasted_token_ratio || 0;
        acc.repeat += run.repeat_issue_rate || 0;
        return acc;
      },
      { tokens: 0, duration: 0, wasted: 0, repeat: 0 },
    );
    return {
      total_runs: runs.length,
      avg_tokens_per_success_task: sum.tokens / count,
      avg_duration_ms: sum.duration / count,
      avg_wasted_token_ratio: sum.wasted / count,
      avg_repeat_issue_rate: sum.repeat / count,
    };
  }

  async recordRun(summary = {}) {
    if (!this.config.enabled) return null;
    const now = Date.now();
    const state = await this._loadState(now);

    state.runs.push({
      timestamp: toIso(now),
      duration_ms: summary.duration_ms || 0,
      tokens_per_success_task: summary.tokens_per_success_task || 0,
      wasted_token_ratio: summary.wasted_token_ratio || 0,
      repeat_issue_rate: summary.repeat_issue_rate || 0,
      critical_clearance_time: summary.critical_clearance_time ?? null,
      alert_count: summary.alert_count || 0,
      done: summary.done || 0,
      failed: summary.failed || 0,
      needs_human: summary.needs_human || 0,
    });

    state.aggregates = this._computeAggregates(state.runs);

    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
    return state;
  }

  generateEvaluationReport(summary = {}, observationState = null) {
    const now = new Date().toISOString();
    const agg = observationState?.aggregates || {};
    return `# Agents 发布评估报告

生成时间: ${now}

## 一、成本维度
- 单成功任务 Token: ${summary.tokens_per_success_task ?? 0}
- 无效 Token 占比: ${summary.wasted_token_ratio ?? 0}
- 观察窗口平均单成功任务 Token: ${agg.avg_tokens_per_success_task ?? 0}
- 观察窗口平均无效 Token 占比: ${agg.avg_wasted_token_ratio ?? 0}

## 二、时延维度
- 本次总耗时(ms): ${summary.duration_ms ?? 0}
- 观察窗口平均耗时(ms): ${agg.avg_duration_ms ?? 0}
- 平均修复轮次: ${summary.avg_cycles ?? 0}

## 三、质量维度
- 收敛率: ${summary.convergence_rate ?? 0}
- 重复问题率: ${summary.repeat_issue_rate ?? 0}
- CRITICAL 清零时间(ms): ${summary.critical_clearance_time ?? 'N/A'}
- 观察窗口平均重复问题率: ${agg.avg_repeat_issue_rate ?? 0}

## 四、运行稳定性
- 报警数量: ${summary.alert_count ?? 0}
- 告警分类分布: ${JSON.stringify(summary.alert_by_category || {})}
- 告警规则分布: ${JSON.stringify(summary.alert_by_rule || {})}
- 观察窗口总运行次数: ${agg.total_runs ?? 0}
- 观察窗口结束时间: ${observationState?.window?.ends_at || 'N/A'}

## 五、错误语义观测
- 最近告警样本: ${JSON.stringify((summary.alert_tail || []).slice(-3), null, 2)}
`;
  }

  async writeEvaluationReport(markdown) {
    await fs.mkdir(this.reportDir, { recursive: true });
    const name = `final-evaluation-${Date.now()}.md`;
    const reportPath = path.join(this.reportDir, name);
    await fs.writeFile(reportPath, markdown, 'utf-8');
    return reportPath;
  }
}

export default ReleaseObserver;
