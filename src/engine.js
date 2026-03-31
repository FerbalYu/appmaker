/**
 * Execution Engine
 * 执行双 Agent 协作流程：claude-code 编程 + opencode 毒舌点评
 */

const { AgentDispatcher } = require('./agents/dispatcher');
const { OpenCodeAdapter } = require('./agents/opencode');
const { ClaudeCodeAdapter } = require('./agents/claude-code');
const fs = require('fs').promises;
const path = require('path');

class ExecutionEngine {
  constructor(config = {}) {
    this.config = config;
    this.tasks = new Map();
    this.checkpoints = [];
    this.logs = [];
    this.maxReviewCycles = config.max_review_cycles || 3;
    this.projectRoot = config.project_root || process.cwd();

    // 创建 dispatcher 实例
    this.dispatcher = new AgentDispatcher({
      opencode_use_cli: config.opencode_use_cli ?? true,
      opencode_cli_path: config.opencode_cli_path || 'opencode',
      claude_code_use_cli: config.claude_code_use_cli ?? true,
      claude_code_cli_path: config.claude_code_cli_path || 'claude'
    });
  }

  /**
   * 执行任务（编程 + 评审循环）
   * @param {Object} plan - 来自 planning.skill 的执行计划
   * @returns {Promise<Object>}
   */
  async execute(plan) {
    this._log('INFO', `开始执行计划: ${plan.project.name}`);
    this._log('INFO', `总任务数: ${plan.tasks.length}`);

    const results = [];
    const startTime = Date.now();

    for (const milestone of plan.milestones) {
      this._log('INFO', `\n=== 里程碑: ${milestone.name} ===`);

      for (const taskId of milestone.tasks) {
        const task = plan.tasks.find(t => t.id === taskId);
        if (!task) {
          this._log('WARN', `任务 ${taskId} 未找到`);
          continue;
        }

        // 检查依赖
        if (this._hasUnmetDeps(task, results)) {
          this.tasks.set(task.id, { status: 'blocked' });
          continue;
        }

        // 执行任务
        const result = await this._executeTask(task, plan);
        results.push(result);
        this.tasks.set(task.id, { status: result.status, result });

        // 进度报告
        this._reportProgress(task, result);
      }

      // 里程碑检查点
      await this._createCheckpoint(`milestone_${milestone.id}`);
    }

    const summary = this._generateSummary(results, startTime);

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
    this._log('INFO', `\n[${task.id}] 开始: ${task.description}`);

    const context = this._buildContext(task, plan);
    let codeResult;
    let reviewResult;
    let cycle = 0;

    // ===== 阶段 1: claude-code 编程 =====
    this._log('INFO', `[${task.id}] claude-code 编程中...`);

    try {
      codeResult = await this.dispatcher.dispatch({
        id: task.id,
        type: task.type || 'create',
        description: task.description,
        files: task.files || [],
        context
      });
    } catch (error) {
      this._log('ERROR', `[${task.id}] claude-code 执行失败: ${error.message}`);
      return {
        task_id: task.id,
        status: 'failed',
        phase: 'code',
        error: error.message
      };
    }

    if (codeResult.status === 'failed' || codeResult.success === false) {
      this._log('ERROR', `[${task.id}] claude-code 执行失败`);
      return {
        task_id: task.id,
        status: 'failed',
        phase: 'code',
        error: codeResult.error || codeResult.errors || 'Unknown error'
      };
    }

    // 检查是否有文件产出
    if (!codeResult.output?.files_created?.length && !codeResult.output?.files_modified?.length) {
      this._log('ERROR', `[${task.id}] claude-code 没有产出任何文件`);
      return {
        task_id: task.id,
        status: 'failed',
        phase: 'code',
        error: 'No files produced'
      };
    }

    this._log('INFO', `[${task.id}] 编程完成，文件: ${codeResult.output?.files_created?.length || 0}`);

    // ===== 阶段 2: opencode 毒舌点评 =====
    this._log('INFO', `[${task.id}] opencode 毒舌点评中...`);

    try {
      reviewResult = await this.dispatcher.dispatch({
        id: `review_${task.id}`,
        type: 'review',
        description: `评审任务: ${task.description}`,
        files: codeResult.output?.files_created || [],
        context
      });
    } catch (error) {
      this._log('ERROR', `[${task.id}] opencode 评审失败: ${error.message}`);
      return {
        task_id: task.id,
        status: 'failed',
        phase: 'review',
        error: error.message
      };
    }

    // ===== 阶段 3: 修正循环 =====
    while (reviewResult.output?.verdict === 'FAIL' && cycle < this.maxReviewCycles) {
      cycle++;
      this._log('WARN', `[${task.id}] 评审 FAIL (第 ${cycle} 次修正)`);

      const issues = reviewResult.output?.issues || [];
      this._logIssues(issues);

      // 构建修正请求
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
        return {
          task_id: task.id,
          status: 'failed',
          phase: 'fix',
          cycle,
          error: error.message
        };
      }

      // 重新评审
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
        return {
          task_id: task.id,
          status: 'failed',
          phase: 're-review',
          cycle,
          error: error.message
        };
      }
    }

    // ===== 结果判定 =====
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

    // 通过
    this._log('INFO', `[${task.id}] ✓ PASS (评分: ${reviewResult.output?.score || 0})`);

    return {
      task_id: task.id,
      status: 'done',
      verdict: reviewResult.output?.verdict,
      score: reviewResult.output?.score,
      cycles: cycle,
      code_result: codeResult,
      review_result: reviewResult
    };
  }

  /**
   * 构建上下文
   * @private
   */
  _buildContext(task, plan) {
    return {
      task_id: task.id,
      project_root: this.projectRoot,
      architecture_rules: this._loadRule('architecture'),
      quality_rules: this._loadRule('quality'),
      checkpoint: this.checkpoints[this.checkpoints.length - 1]
    };
  }

  /**
   * 加载规则文件
   * @private
   */
  _loadRule(ruleName) {
    try {
      const rulePath = path.join(__dirname, '..', 'rules', `${ruleName}.rules.md`);
      if (fs.existsSync(rulePath)) {
        return fs.readFileSync(rulePath, 'utf-8');
      }
    } catch {
      // 忽略
    }
    return '';
  }

  /**
   * 构建修正 prompt
   * @private
   */
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

  /**
   * 检查是否有未满足的依赖
   * @private
   */
  _hasUnmetDeps(task, results) {
    if (!task.dependencies || task.dependencies.length === 0) {
      return false;
    }
    return task.dependencies.some(depId => {
      const result = results.find(r => r.task_id === depId);
      return !result || result.status !== 'done';
    });
  }

  /**
   * 输出问题列表
   * @private
   */
  _logIssues(issues) {
    for (const issue of issues) {
      const icon = issue.severity === 'CRITICAL' ? '🔴' : issue.severity === 'WARNING' ? '🟡' : '🟢';
      this._log('WARN', `  ${icon} ${issue.title} (${issue.file})`);
    }
  }

  /**
   * 报告进度
   * @private
   */
  _reportProgress(task, result) {
    const total = this.tasks.size;
    const done = [...this.tasks.values()].filter(t => t.status === 'done').length;
    const pct = Math.round((done / total) * 100);

    console.log(`\n[PROGRESS] ${done}/${total} (${pct}%)`);
    console.log(`  █${'█'.repeat(Math.floor(pct / 5))}${'░'.repeat(20 - Math.floor(pct / 5))}`);
  }

  /**
   * 创建检查点
   * @private
   */
  async _createCheckpoint(name) {
    const checkpoint = {
      id: `cp_${Date.now()}`,
      name,
      timestamp: new Date().toISOString(),
      tasks: Object.fromEntries(this.tasks),
      logs: this.logs.slice(-100) // 只保留最近 100 条
    };
    this.checkpoints.push(checkpoint);

    // 保存到文件
    try {
      await fs.mkdir(path.join(this.projectRoot, '.appmaker', 'checkpoints'), { recursive: true });
      await fs.writeFile(
        path.join(this.projectRoot, '.appmaker', 'checkpoints', `${checkpoint.id}.json`),
        JSON.stringify(checkpoint, null, 2)
      );
    } catch {
      // 忽略
    }

    this._log('INFO', `检查点创建: ${name}`);
    return checkpoint.id;
  }

  /**
   * 生成总结
   * @private
   */
  _generateSummary(results, startTime) {
    const done = results.filter(r => r.status === 'done').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const needsHuman = results.filter(r => r.status === 'needs_human').length;
    const totalCycles = results.reduce((sum, r) => sum + (r.cycles || 0), 0);
    const avgScore = results.reduce((sum, r) => sum + (r.score || 0), 0) / results.length;

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

  /**
   * 记录日志
   * @private
   */
  _log(level, message) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message
    };
    this.logs.push(entry);
    console.log(`[${level}] ${message}`);
  }

  /**
   * 恢复执行
   * @param {string} checkpointId
   */
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

module.exports = { ExecutionEngine };
