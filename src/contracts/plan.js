function stringOrDefault(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrDefault(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const VALID_TASK_TYPES = new Set([
  'architect',
  'create',
  'modify',
  'test',
  'integrate',
  'deploy',
  'docs',
]);

function normalizeTask(task, index) {
  const id = stringOrDefault(task.id, `t${index + 1}`);
  return {
    id,
    description: stringOrDefault(task.description, `任务 ${index + 1}`),
    type: VALID_TASK_TYPES.has(task.type) ? task.type : 'create',
    dependencies: arrayOrEmpty(task.dependencies),
    agent: stringOrDefault(task.agent, 'native-coder'),
    estimated_tokens: numberOrDefault(task.estimated_tokens, 2000),
    estimated_minutes: numberOrDefault(task.estimated_minutes, 10),
    files: arrayOrEmpty(task.files),
    subtasks: arrayOrEmpty(task.subtasks),
    goal: stringOrDefault(task.goal),
    execution_mode: stringOrDefault(task.execution_mode),
    replan_plan: task.replan_plan && typeof task.replan_plan === 'object' ? task.replan_plan : null,
  };
}

function normalizeMilestone(ms, index, validTaskIds) {
  const id = stringOrDefault(ms.id, `m${index + 1}`);
  const tasks = arrayOrEmpty(ms.tasks).filter((taskId) => validTaskIds.has(taskId));
  return {
    id,
    name: stringOrDefault(ms.name, `里程碑 ${index + 1}`),
    tasks,
    deliverables: arrayOrEmpty(ms.deliverables),
  };
}

function buildTaskIdSet(tasks) {
  const ids = new Set();
  for (const task of tasks) {
    ids.add(task.id);
  }
  return ids;
}

export function assertPlanShape(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Invalid plan: not an object');
  }
  if (!Array.isArray(plan.tasks)) {
    throw new Error('Invalid plan: tasks is not an array');
  }
  if (plan.tasks.length === 0) {
    throw new Error('Invalid plan: tasks array is empty');
  }
  if (!Array.isArray(plan.milestones)) {
    throw new Error('Invalid plan: milestones is not an array');
  }
  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i];
    if (!task.id) {
      throw new Error(`Invalid plan: task at index ${i} missing id`);
    }
    if (!task.description) {
      throw new Error(`Invalid plan: task ${task.id} missing description`);
    }
  }
}

export function normalizePlan(plan = {}) {
  assertPlanShape(plan);

  plan.plan_id = stringOrDefault(plan.plan_id, `plan_${Date.now()}`);
  plan.created_at = stringOrDefault(plan.created_at, new Date().toISOString());
  plan.requirement = stringOrDefault(plan.requirement);

  const project = objectOrEmpty(plan.project);
  plan.project = {
    name: stringOrDefault(project.name, 'unknown-project'),
    description: stringOrDefault(project.description),
  };

  plan.features = arrayOrEmpty(plan.features);

  const tasks = arrayOrEmpty(plan.tasks).map(normalizeTask);
  const taskIds = buildTaskIdSet(tasks);

  for (const task of tasks) {
    task.dependencies = task.dependencies.filter((depId) => taskIds.has(depId));
  }

  plan.tasks = tasks;
  plan.milestones = arrayOrEmpty(plan.milestones).map((ms, i) =>
    normalizeMilestone(ms, i, taskIds),
  );

  plan.metadata = {
    total_tasks: tasks.length,
    estimated_tokens: numberOrDefault(plan.metadata?.estimated_tokens, 0),
    total_minutes_estimate: numberOrDefault(plan.metadata?.total_minutes_estimate, 0),
    ...(plan.metadata?.rainmaker_planning_stages
      ? { rainmaker_planning_stages: plan.metadata.rainmaker_planning_stages }
      : {}),
  };

  return plan;
}
