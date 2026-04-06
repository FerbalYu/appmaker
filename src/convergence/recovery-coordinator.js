export class RecoveryCoordinator {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      max_recoveries_per_milestone: config.max_recoveries_per_milestone || 2,
      enable_probe_replan: config.enable_probe_replan !== false,
      ...config,
    };
  }

  async attemptDependencyRecovery({
    blockedTasks = [],
    graph,
    completed,
    persistedTasks,
    milestoneId,
    stateProbe,
    projectRoot,
    goalInvariant,
  } = {}) {
    const recovered = [];
    if (!this.config.enabled || blockedTasks.length === 0) {
      return { recovered_task_ids: recovered, milestone_id: milestoneId, decisions: [] };
    }

    const decisions = [];
    for (const task of blockedTasks) {
      if (recovered.length >= this.config.max_recoveries_per_milestone) {
        break;
      }
      const node = graph.get(task.id);
      if (!node) continue;

      const failedDeps = [...node.dependencies].filter((depId) => {
        const depRes = completed.get(depId) || persistedTasks.get(depId)?.result;
        const st = depRes?.status;
        return st && st !== 'done';
      });
      if (failedDeps.length === 0) continue;

      const probeResult = await stateProbe.evaluateTaskState(task, projectRoot);
      if (!probeResult.already_satisfied) {
        if (this.config.enable_probe_replan) {
          const replanPlan = this._buildProbeReplanPlan(task, probeResult, goalInvariant);
          this._applyProbeDrivenReplan(task, replanPlan);
          for (const depId of failedDeps) {
            node.dependencies.delete(depId);
          }
          recovered.push(task.id);
          decisions.push({
            task_id: task.id,
            action: 'probe_replan',
            waived_dependencies: failedDeps,
            reason: 'replanned_from_project_state',
            missing_artifacts: probeResult.missing_artifacts || [],
            goal: goalInvariant?.summary || '',
            replan_plan: replanPlan,
          });
          continue;
        }
        decisions.push({
          task_id: task.id,
          action: 'keep_blocked',
          reason: probeResult.reason,
          missing_artifacts: probeResult.missing_artifacts || [],
        });
        continue;
      }

      for (const depId of failedDeps) {
        node.dependencies.delete(depId);
      }
      recovered.push(task.id);
      decisions.push({
        task_id: task.id,
        action: 'dependency_waived',
        waived_dependencies: failedDeps,
        reason: 'task_already_satisfied_by_project_state',
      });
    }

    return {
      recovered_task_ids: recovered,
      milestone_id: milestoneId,
      decisions,
    };
  }

  _buildProbeReplanPlan(task, probeResult, goalInvariant) {
    const missingArtifacts = (probeResult?.missing_artifacts || []).slice(0, 6);
    const goalText = goalInvariant?.summary || task.goal || '保持原始业务目标不变';
    return {
      strategy: 'probe_driven_replan',
      goal: goalText,
      phases: [
        {
          name: 'state_probe',
          objective: '基于当前项目状态确认缺失工件并校准执行路径',
        },
        {
          name: 'gap_fill',
          objective: `优先补齐缺失工件: ${missingArtifacts.join(', ') || '未知工件'}`,
        },
        {
          name: 'goal_resume',
          objective: '完成补洞后回到原任务目标，保持业务目的不变',
        },
      ],
      missing_artifacts: missingArtifacts,
    };
  }

  _applyProbeDrivenReplan(task, replanPlan) {
    const marker = '[PROBE_REPLAN]';
    if (String(task.description || '').includes(marker)) {
      return;
    }
    const missing = replanPlan.missing_artifacts.join(', ') || '未知工件';
    const goalText = replanPlan.goal;
    task.description =
      `${task.description}\n` +
      `${marker} 动态重规划：计划可变，目的不可变。\n` +
      `目标约束：${goalText}\n` +
      `优先补齐缺失工件：${missing}\n` +
      `完成后继续回到当前任务目标，不得偏离。`;
    task.goal = goalText;
    task.execution_mode = 'probe_replan';
    task.replan_plan = replanPlan;
    const previousSubtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    task.subtasks = [
      ...previousSubtasks,
      '执行阶段1: 状态探针确认缺失与可复用资产',
      `基于当前项目状态补齐缺失工件: ${missing}`,
      '执行阶段3: 补洞完成后回归原目标并验证目标一致性',
    ];
  }
}

export default RecoveryCoordinator;
