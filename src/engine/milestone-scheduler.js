export function buildTaskGraph(tasks) {
  const graph = new Map();
  for (const task of tasks) {
    graph.set(task.id, {
      task,
      dependencies: new Set(task.dependencies || []),
      dependents: new Set(),
    });
  }
  for (const [id, node] of graph) {
    for (const depId of node.dependencies) {
      if (graph.has(depId)) {
        graph.get(depId).dependents.add(id);
      }
    }
  }
  return graph;
}

export function getAvailableTasks(graph, executing, completed, tasksMap) {
  const available = [];
  for (const [id, node] of graph) {
    if (completed.has(id) || executing.has(id)) continue;

    const depsSatisfied = [...node.dependencies].every(
      (depId) =>
        (completed.has(depId) && completed.get(depId)?.status === 'done') ||
        (tasksMap.has(depId) && tasksMap.get(depId)?.status === 'done'),
    );

    if (depsSatisfied) {
      available.push(node.task);
    }
  }
  return available;
}

export function detectBlockedTasks({ graph, completed, executing, tasks, tasksMap }) {
  const blocked = tasks.filter((t) => !completed.has(t.id) && !executing.has(t.id));
  if (blocked.length === 0) return { blocked: [], deadlockCount: 0, blockedDetails: [], failedDependencyReasons: new Map() };

  let deadlockCount = 0;
  const blockedDetails = [];
  const failedDependencyReasons = new Map();

  for (const task of blocked) {
    const deps = task.dependencies || [];
    const failedDeps = deps.filter((depId) => {
      const depRes = completed.get(depId) || tasksMap.get(depId)?.result;
      const st = depRes?.status;
      return st && st !== 'done';
    });
    const hasFailedDep = failedDeps.length > 0;
    const errorResult = hasFailedDep
      ? { task_id: task.id, status: 'blocked', error: '依赖任务失败或未完成' }
      : { task_id: task.id, status: 'deadlock', error: '任务依赖无法满足' };

    if (errorResult.status === 'deadlock') deadlockCount++;

    if (hasFailedDep) {
      blockedDetails.push(`${task.id} <= [${failedDeps.join(', ')}]`);
      for (const depId of failedDeps) {
        const depRes = completed.get(depId) || tasksMap.get(depId)?.result;
        const reason = depRes?.error || depRes?.result?.error || depRes?.phase || depRes?.status;
        if (!failedDependencyReasons.has(depId)) {
          failedDependencyReasons.set(depId, reason || 'unknown');
        }
      }
    }
  }

  return { blocked, deadlockCount, blockedDetails, failedDependencyReasons };
}
