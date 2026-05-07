import { promises as fs } from 'fs';
import path from 'path';

export async function loadRule(ruleName, baseDir) {
  try {
    const rulePath = path.join(baseDir, '..', 'rules', `${ruleName}.rules.md`);
    return await fs.readFile(rulePath, 'utf-8');
  } catch {
    return '';
  }
}

export function buildGoalInvariant(plan) {
  const project = plan?.project || {};
  const summary = [project.name, project.description, plan?.requirement]
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .join(' | ')
    .substring(0, 240);
  return {
    summary: summary || '保持原始业务目标不变',
    created_at: new Date().toISOString(),
  };
}

export async function buildTaskContext({
  task,
  projectRoot,
  goalInvariantSummary,
  checkpoints,
  loadRuleFn,
}) {
  const preflight = task._preflight || null;
  return {
    task_id: task.id,
    project_root: projectRoot,
    goal_invariant: goalInvariantSummary || '',
    execution_mode: task.execution_mode || null,
    replan_plan: task.replan_plan || null,
    state_probe_preflight: preflight,
    architecture_rules: await loadRuleFn('architecture'),
    quality_rules: await loadRuleFn('quality'),
    checkpoint: checkpoints[checkpoints.length - 1],
  };
}
