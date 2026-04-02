import { ExecutionEngine } from '../src/engine.js';

describe('ExecutionEngine', () => {
  it('should be instantiable without throwing', () => {
    const engine = new ExecutionEngine({ project_root: process.cwd() });
    expect(engine).toBeInstanceOf(ExecutionEngine);
  });

  it('should maintain state of checkpoints correctly', () => {
    const engine = new ExecutionEngine({ project_root: process.cwd() });
    expect(engine.checkpoints.length).toBe(0);
  });

  it('should disable task timeout by default', () => {
    const engine = new ExecutionEngine({ project_root: process.cwd() });
    expect(engine.config.task_timeout).toBe(0);
  });

  it('should disable max review cycles by default', () => {
    const engine = new ExecutionEngine({ project_root: process.cwd() });
    expect(engine.config.max_review_cycles).toBe(0);
  });

  it('should treat "timed out" timeout errors as retryable', () => {
    const engine = new ExecutionEngine({ project_root: process.cwd() });
    const error = new Error('[native-coder] Task t1 timed out after 300s');
    expect(engine._isRetryableError(error)).toBe(true);
  });

  it('should include blocked/deadlock in summary and log details', async () => {
    const engine = new ExecutionEngine({ project_root: process.cwd(), max_concurrent_tasks: 1 });
    // Mock dispatcher to force one task fail and another depend on it
    engine.dispatcher.registerAgent('native-coder', () => ({
      name: 'native-coder',
      execute: async (task) => {
        if (task.id === 'a') {
          return { success: false, error: 'forced fail', status: 'failed' };
        }
        return { task_id: task.id, success: true, status: 'success', output: {} };
      },
      setPermissionClassifier: () => {}
    }));
    engine.dispatcher.registerAgent('native-reviewer', () => ({
      name: 'native-reviewer',
      execute: async () => ({ success: true, status: 'success', output: { score: 100, issues: [] } }),
      setPermissionClassifier: () => {}
    }));
    const plan = {
      plan_id: 'blocked_test',
      project: { name: 'Blocked Test' },
      tasks: [
        { id: 'a', description: 'fail source', type: 'create', agent: 'native-coder', dependencies: [] },
        { id: 'b', description: 'blocked by a', type: 'create', agent: 'native-coder', dependencies: ['a'] }
      ],
      milestones: [{ id: 'm1', name: 'm1', tasks: ['a','b'] }]
    };
    const result = await engine.execute(plan);
    expect(result.summary.blocked + result.summary.deadlock).toBeGreaterThanOrEqual(1);
    expect(['partial','success']).toContain(result.status);
  });

  it('should mark needs_human when max_review_cycles is limited and score stays low', async () => {
    const engine = new ExecutionEngine({ project_root: process.cwd(), max_concurrent_tasks: 1, max_review_cycles: 1 });
    engine.dispatcher.registerAgent('native-coder', () => ({
      name: 'native-coder',
      execute: async (task) => ({
        task_id: task.id,
        success: true,
        status: 'success',
        output: { files_created: ['main.py'], files_modified: [] }
      }),
      setPermissionClassifier: () => {}
    }));
    engine.dispatcher.registerAgent('native-reviewer', () => ({
      name: 'native-reviewer',
      execute: async () => ({
        task_id: 'review_t1',
        success: true,
        status: 'success',
        output: { score: 60, issues: ['low score'], summary: 'FAIL' }
      }),
      setPermissionClassifier: () => {}
    }));
    const plan = {
      plan_id: 'limit_cycles',
      project: { name: 'Limit Cycles' },
      tasks: [{ id: 't1', description: 'force fail review', type: 'create', agent: 'native-coder', dependencies: [] }],
      milestones: [{ id: 'm1', name: 'm1', tasks: ['t1'] }]
    };
    const result = await engine.execute(plan);
    expect(result.summary.needs_human).toBeGreaterThanOrEqual(1);
  });
});
