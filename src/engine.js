/**
 * Execution Engine
 * 执行双 Agent 协作流程：claude-code 编程 + opencode 毒舌点评
 */

import { AgentDispatcher } from './agents/dispatcher.js';
import { NativeCoderAdapter } from './agents/native-coder.js';
import { NativeReviewerAdapter } from './agents/native-reviewer.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ExecutionEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.tasks = new Map();
    this.checkpoints = [];
    this.logs = [];
    this.maxReviewCycles = config.max_review_cycles || 3;
    this.projectRoot = config.project_root || process.cwd();

    this.dispatcher = new AgentDispatcher({
      native_reviewer_model: config.native_reviewer_model || 'MiniMax-Text-01',
      native_coder_model: config.native_coder_model || 'MiniMax-Text-01'
    });

    this.dispatcher.registerAgent('native-reviewer', new NativeReviewerAdapter({
      model: config.native_reviewer_model,
      api_key: config.api_key || process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY,
      api_host: config.api_host || process.env.OPENAI_API_BASE || process.env.MINIMAX_API_HOST
    }));
    this.dispatcher.registerAgent('native-coder', new NativeCoderAdapter({
      model: config.native_coder_model,
      api_key: config.api_key || process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY,
      api_host: config.api_host || process.env.OPENAI_API_BASE || process.env.MINIMAX_API_HOST
    }));
  }

  /**
   * 执行任务（编程 + 评审循环）
   * @param {Object} plan
   * @returns {Promise<Object>}
   */
  async execute(plan) {
    this._log('INFO', `开始执行计划: ${plan.project.name}`);
    this._log('INFO', `总任务数: ${plan.tasks.length}`);

    const results = [];
    const startTime = Date.now();

    for (const milestone of plan.milestones) {
      this._log('INFO', `\n=== 里程碑: ${milestone.name} ===`);
      this.emit('milestone:start', { milestone, plan });

      const executionPromises = new Map();
      const milestoneTasks = milestone.tasks
        .map(id => plan.tasks.find(t => t.id === id))
        .filter(t => {
          if (!t) this._log('WARN', '任务未找到');
          return Boolean(t);
        });

      const scheduleTask = async (task) => {
        const existing = this.tasks.get(task.id);
        if (existing?.status === 'done') return existing.result;

        if (task.dependencies?.length > 0) {
          const depResults = await Promise.all(
            task.dependencies.map(depId => {
              if (executionPromises.has(depId)) return executionPromises.get(depId);
              const pastState = this.tasks.get(depId);
              if (pastState) return Promise.resolve(pastState.result || { status: pastState.status });
              return Promise.resolve({ status: 'done' });
            })
          );
          if (depResults.some(r => r?.status !== 'done')) {
            const blockedResult = { task_id: task.id, status: 'blocked' };
            this.tasks.set(task.id, { status: 'blocked', result: blockedResult });
            return blockedResult;
          }
        }

        if (this.halt) {
          this._log('WARN', `由于系统风控 (halt)，任务 ${task.id} 被中止执行`);
          return { status: 'aborted' };
        }

        const result = await this._executeTask(task, plan);
        results.push(result);
        this.tasks.set(task.id, { status: result.status, result });
        this._reportProgress(task, result);
        return result;
      };

      for (const task of milestoneTasks) {
        executionPromises.set(task.id, scheduleTask(task));
      }

      await Promise.all(executionPromises.values());

      await this._createCheckpoint(`milestone_${milestone.id}`);
      this.emit('milestone:done', { milestone, plan });
    }

    const summary = this._generateSummary(results, startTime);
    this.emit('plan:done', { plan, summary, results });

    return {
      plan_id: plan.plan_id,
      status: summary.failed > 0 ? 'partial' : 'success',
      results,
      summary
    };
  }

  /**
   * 执行单个任务：编程 → 评审 → 修正循环
   * @private
   */
  async _executeTask(task, plan) {
    this.emit('task:start', { task, plan });
    this._log('INFO', `\n[${task.id}] 开始: ${task.description}`);

    const context = await this._buildContext(task, plan);
    let codeResult;
    let reviewResult;
    let cycle = 0;

    // 阶段 1: native-coder 编程
    this._log('INFO', `[${task.id}] native-coder 编程中...`);
    try {
      codeResult = await this.dispatcher.dispatch({
        id: task.id,
        type: task.type || 'create',
        description: task.description,
        files: task.files || [],
        context
      });
    } catch (error) {
      this._log('ERROR', `[${task.id}] native-coder 执行失败: ${error.message}`);
      return { task_id: task.id, status: 'failed', phase: 'code', error: error.message };
    }

    if (codeResult.status === 'failed' || codeResult.success === false) {
      this._log('ERROR', `[${task.id}] native-coder 执行失败`);
      const errRes = { task_id: task.id, status: 'failed', phase: 'code', error: codeResult.error || codeResult.errors || 'Unknown error' };
      this.emit('task:error', { task, result: errRes });
      return errRes;
    }

    if (!codeResult.output?.files_created?.length && !codeResult.output?.files_modified?.length) {
      this._log('WARN', `[${task.id}] native-coder 本次执行没有生成或修改任何文件。`);
    } else {
      this._log('INFO', `[${task.id}] 编程完成，文件: ${(codeResult.output?.files_created?.length || 0) + (codeResult.output?.files_modified?.length || 0)}`);
    }

    // 阶段 2: native-reviewer 代码审查
    this._log('INFO', `[${task.id}] native-reviewer 审查代码中...`);
    try {
      reviewResult = await this.dispatcher.dispatch({
        id: `review_${task.id}`,
        type: 'review',
        description: `评审任务: ${task.description}`,
        files: codeResult.output?.files_created || [],
        context
      });
      this.emit('task:review', { task, result: reviewResult });
    } catch (error) {
      this._log('ERROR', `[${task.id}] native-reviewer 评审失败: ${error.message}`);
      return { task_id: task.id, status: 'failed', phase: 'review', error: error.message };
    }

    // 阶段 3: 修正循环
    while (reviewResult.output?.verdict === 'FAIL' && cycle < this.maxReviewCycles) {
      cycle++;
      this._log('WARN', `[${task.id}] 评审 FAIL (第 ${cycle} 次修正)`);

      const issues = reviewResult.output?.issues || [];
      this._logIssues(issues);

      const fixPrompt = this._buildFixPrompt(task, codeResult, reviewResult);

      try {
        codeResult = await this.dispatcher.dispatch({
          id: `${task.id}_fix_${cycle}`,
          type: 'modify',
          description: fixPrompt,
          files: codeResult.output?.files_created || [],
          context
        });
      } catch (error) {
        this._log('ERROR', `[${task.id}] 修正失败: ${error.message}`);
        return { task_id: task.id, status: 'failed', phase: 'fix', cycle, error: error.message };
      }

      try {
        reviewResult = await this.dispatcher.dispatch({
          id: `review_${task.id}_${cycle}`,
          type: 'review',
          description: `重新评审: ${task.description}`,
          files: codeResult.output?.files_created || [],
          context
        });
      } catch (error) {
        this._log('ERROR', `[${task.id}] 重新评审失败`);
        return { task_id: task.id, status: 'failed', phase: 're-review', cycle, error: error.message };
      }
    }

    // 结果判定
    if (reviewResult.output?.verdict === 'FAIL' && cycle >= this.maxReviewCycles) {
      this._log('ERROR', `[${task.id}] 超过最大修正次数，人工介入`);
      return {
        task_id: task.id,
        status: 'needs_human',
        phase: 'exhausted',
        cycles: cycle,
        issues: reviewResult.output?.issues,
        code_result: codeResult
      };
    }

    this._log('INFO', `[${task.id}] ✓ PASS (评分: ${reviewResult.output?.score || 0})`);

    const finalResult = {
      task_id: task.id,
      status: 'done',
      verdict: reviewResult.output?.verdict,
      score: reviewResult.output?.score,
      cycles: cycle,
      code_result: codeResult,
      review_result: reviewResult
    };
    this.emit('task:done', { task, result: finalResult });
    return finalResult;
  }

  async _buildContext(task, plan) {
    return {
      task_id: task.id,
      project_root: this.projectRoot,
      architecture_rules: await this._loadRule('architecture'),
      quality_rules: await this._loadRule('quality'),
      checkpoint: this.checkpoints[this.checkpoints.length - 1]
    };
  }

  async _loadRule(ruleName) {
    try {
      const rulePath = path.join(__dirname, '..', 'rules', `${ruleName}.rules.md`);
      return await fs.readFile(rulePath, 'utf-8');
    } catch {
      return '';
    }
  }

  _buildFixPrompt(task, codeResult, reviewResult) {
    const issues = reviewResult.output?.issues || [];
    const issueList = issues.map((issue, i) =>
      `${i + 1}. [${issue.severity}] ${issue.title}\n   文件: ${issue.file}\n   问题: ${issue.reason}\n   建议: ${issue.suggestion}`
    ).join('\n');

    return `修正以下代码中的问题：

任务: ${task.description}

需修正的问题:
${issueList}

请根据以上问题修改代码，确保：
1. 所有 CRITICAL 问题必须修复
2. 所有 WARNING 问题尽量修复
3. 保持原有功能不变

修改后确保代码通过质量检查。`;
  }

  _logIssues(issues) {
    for (const issue of issues) {
      const icon = issue.severity === 'CRITICAL' ? '🔴' : issue.severity === 'WARNING' ? '🟡' : '🟢';
      this._log('WARN', `  ${icon} ${issue.title} (${issue.file})`);
    }
  }

  _reportProgress(task, result) {
    const total = this.tasks.size;
    const done = [...this.tasks.values()].filter(t => t.status === 'done').length;
    const pct = Math.round((done / total) * 100);
    console.log(`\n[PROGRESS] ${done}/${total} (${pct}%)`);
    console.log(`  █${'█'.repeat(Math.floor(pct / 5))}${'░'.repeat(20 - Math.floor(pct / 5))}`);
  }

  async _createCheckpoint(name) {
    const checkpoint = {
      id: `cp_${Date.now()}`,
      name,
      timestamp: new Date().toISOString(),
      tasks: Object.fromEntries(this.tasks),
      logs: this.logs.slice(-100)
    };
    this.checkpoints.push(checkpoint);

    try {
      const dir = path.join(this.projectRoot, '.appmaker', 'checkpoints');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, `${checkpoint.id}.json`),
        JSON.stringify(checkpoint, null, 2)
      );
    } catch { /* ignore */ }

    this._log('INFO', `检查点创建: ${name}`);
    return checkpoint.id;
  }

  _generateSummary(results, startTime) {
    const done = results.filter(r => r.status === 'done').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const needsHuman = results.filter(r => r.status === 'needs_human').length;
    const totalCycles = results.reduce((sum, r) => sum + (r.cycles || 0), 0);
    const avgScore = results.reduce((sum, r) => sum + (r.score || 0), 0) / (results.length || 1);

    return {
      total: results.length,
      done,
      failed,
      needs_human: needsHuman,
      total_review_cycles: totalCycles,
      average_score: Math.round(avgScore),
      duration_ms: Date.now() - startTime
    };
  }

  _log(level, message) {
    const entry = { timestamp: new Date().toISOString(), level, message };
    this.logs.push(entry);
    console.log(`[${level}] ${message}`);
  }

  async restore(checkpointId) {
    try {
      const cp = await fs.readFile(
        path.join(this.projectRoot, '.appmaker', 'checkpoints', `${checkpointId}.json`),
        'utf-8'
      );
      const checkpoint = JSON.parse(cp);
      this.tasks = new Map(Object.entries(checkpoint.tasks));
      this.checkpoints.push(checkpoint);
      this._log('INFO', `已恢复检查点: ${checkpointId}`);
      return checkpoint;
    } catch (error) {
      this._log('ERROR', `恢复失败: ${error.message}`);
      return null;
    }
  }
}
