import { ExecutionEngine } from '../src/engine.js';
import { existsSync, readFileSync } from 'fs';

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

  it('should handoff when reviewer parse failures are repeated', async () => {
    const engine = new ExecutionEngine({
      project_root: process.cwd(),
      max_concurrent_tasks: 1,
      max_review_cycles: 2,
      convergence: { max_parse_failures: 1 },
    });
    engine.dispatcher.registerAgent('native-coder', () => ({
      name: 'native-coder',
      execute: async (task) => ({
        task_id: task.id,
        success: true,
        status: 'success',
        output: { files_created: ['main.py'], files_modified: [] },
      }),
      setPermissionClassifier: () => {},
    }));
    engine.dispatcher.registerAgent('native-reviewer', () => ({
      name: 'native-reviewer',
      execute: async () => ({
        task_id: 'review_t1',
        success: false,
        status: 'failed',
        error: '评审输出解析失败',
        error_code: 'PARSE_FAILED',
      }),
      setPermissionClassifier: () => {},
    }));
    const plan = {
      plan_id: 'parse_storm',
      project: { name: 'Parse Storm' },
      tasks: [{ id: 't1', description: 'force parse fail', type: 'create', agent: 'native-coder', dependencies: [] }],
      milestones: [{ id: 'm1', name: 'm1', tasks: ['t1'] }],
    };
    const result = await engine.execute(plan);
    expect(result.summary.needs_human).toBeGreaterThanOrEqual(1);
    expect(result.results[0].stop_reason).toBe('PARSE_FAILURE_STORM');
  });

  it('should disable controller handoff when feature flag is off', async () => {
    const engine = new ExecutionEngine({
      project_root: process.cwd(),
      max_concurrent_tasks: 1,
      max_review_cycles: 1,
      feature_flags: { controller: false, gate: true, parser: true, fingerprint: true },
    });
    engine.dispatcher.registerAgent('native-coder', () => ({
      name: 'native-coder',
      execute: async (task) => ({
        task_id: task.id,
        success: true,
        status: 'success',
        output: { files_created: ['main.py'], files_modified: [] },
      }),
      setPermissionClassifier: () => {},
    }));
    engine.dispatcher.registerAgent('native-reviewer', () => ({
      name: 'native-reviewer',
      execute: async () => ({
        task_id: 'review_t1',
        success: true,
        status: 'success',
        output: { score: 60, issues: ['low score'], summary: 'FAIL' },
      }),
      setPermissionClassifier: () => {},
    }));
    const plan = {
      plan_id: 'controller_off',
      project: { name: 'Controller Off' },
      tasks: [{ id: 't1', description: 'low score loop', type: 'create', agent: 'native-coder', dependencies: [] }],
      milestones: [{ id: 'm1', name: 'm1', tasks: ['t1'] }],
    };
    const result = await engine.execute(plan);
    expect(result.summary.needs_human).toBeGreaterThanOrEqual(1);
    expect(result.results[0].stop_reason).toBe('MAX_REVIEW_CYCLES');
  });

  it('should output AB shadow divergence summary when enabled', async () => {
    const engine = new ExecutionEngine({
      project_root: process.cwd(),
      max_concurrent_tasks: 1,
      max_review_cycles: 2,
      ab_test: { enabled: true, mode: 'shadow' },
      convergence: { window_size: 2, min_score_delta: 100, max_repeat_issue_rate: 0, handoff_enabled: true },
      feature_flags: { controller: true, gate: true, parser: true, fingerprint: true },
    });
    engine.dispatcher.registerAgent('native-coder', () => ({
      name: 'native-coder',
      execute: async (task) => ({
        task_id: task.id,
        success: true,
        status: 'success',
        output: { files_created: ['main.py'], files_modified: [] },
      }),
      setPermissionClassifier: () => {},
    }));
    engine.dispatcher.registerAgent('native-reviewer', () => ({
      name: 'native-reviewer',
      execute: async () => ({
        task_id: 'review_t1',
        success: true,
        status: 'success',
        output: {
          score: 60,
          issues: [{ severity: 'WARNING', title: 'x', file: 'main.py', reason: 'same' }],
          summary: 'FAIL',
        },
      }),
      setPermissionClassifier: () => {},
    }));

    const plan = {
      plan_id: 'ab_shadow',
      project: { name: 'AB Shadow' },
      tasks: [{ id: 't1', description: 'ab compare', type: 'create', agent: 'native-coder', dependencies: [] }],
      milestones: [{ id: 'm1', name: 'm1', tasks: ['t1'] }],
    };
    const result = await engine.execute(plan);
    expect(result.summary.ab_test).toBeDefined();
    expect(result.summary.ab_test.mode).toBe('shadow');
    expect(result.summary.ab_test.total_compares).toBeGreaterThan(0);
    expect(result.summary.ab_test.divergence_count).toBeGreaterThanOrEqual(0);
  });

  it('should support runtime feature flag rollback with audit trail', async () => {
    const engine = new ExecutionEngine({
      project_root: process.cwd(),
      max_concurrent_tasks: 1,
      max_review_cycles: 1,
      feature_flags: { controller: true, gate: true, parser: true, fingerprint: true },
    });
    engine.updateFeatureFlags({ controller: false }, { reason: 'rollback', actor: 'test' });
    engine.dispatcher.registerAgent('native-coder', () => ({
      name: 'native-coder',
      execute: async (task) => ({
        task_id: task.id,
        success: true,
        status: 'success',
        output: { files_created: ['main.py'], files_modified: [] },
      }),
      setPermissionClassifier: () => {},
    }));
    engine.dispatcher.registerAgent('native-reviewer', () => ({
      name: 'native-reviewer',
      execute: async () => ({
        task_id: 'review_t1',
        success: true,
        status: 'success',
        output: { score: 60, issues: ['low score'], summary: 'FAIL' },
      }),
      setPermissionClassifier: () => {},
    }));
    const plan = {
      plan_id: 'runtime_rollback',
      project: { name: 'Runtime Rollback' },
      tasks: [{ id: 't1', description: 'rollback test', type: 'create', agent: 'native-coder', dependencies: [] }],
      milestones: [{ id: 'm1', name: 'm1', tasks: ['t1'] }],
    };
    const result = await engine.execute(plan);
    expect(result.results[0].stop_reason).toBe('MAX_REVIEW_CYCLES');
    expect(result.summary.feature_flag_audit_count).toBeGreaterThanOrEqual(1);
  });

  it('should allow task-level feature flag override', async () => {
    const engine = new ExecutionEngine({
      project_root: process.cwd(),
      max_concurrent_tasks: 1,
      max_review_cycles: 1,
      feature_flags: { controller: true, gate: true, parser: true, fingerprint: true },
    });
    engine.dispatcher.registerAgent('native-coder', () => ({
      name: 'native-coder',
      execute: async (task) => ({
        task_id: task.id,
        success: true,
        status: 'success',
        output: { files_created: ['main.py'], files_modified: [] },
      }),
      setPermissionClassifier: () => {},
    }));
    engine.dispatcher.registerAgent('native-reviewer', () => ({
      name: 'native-reviewer',
      execute: async () => ({
        task_id: 'review_t1',
        success: true,
        status: 'success',
        output: { score: 60, issues: ['low score'], summary: 'FAIL' },
      }),
      setPermissionClassifier: () => {},
    }));
    const plan = {
      plan_id: 'task_override',
      project: { name: 'Task Override' },
      tasks: [{
        id: 't1',
        description: 'task level override',
        type: 'create',
        agent: 'native-coder',
        dependencies: [],
        feature_flags: { controller: false },
      }],
      milestones: [{ id: 'm1', name: 'm1', tasks: ['t1'] }],
    };
    const result = await engine.execute(plan);
    expect(result.results[0].stop_reason).toBe('MAX_REVIEW_CYCLES');
  });

  it('should build differential patch prompt instead of full rewrite prompt', () => {
    const engine = new ExecutionEngine({ project_root: process.cwd() });
    const prompt = engine._buildFixPrompt(
      { description: '修复登录功能' },
      {},
      { output: { issues: [] } },
      '请修复',
      [
        {
          severity: 'CRITICAL',
          file: 'src/auth.js',
          title: '空指针',
          suggestion: '加判空',
        },
      ],
    );
    expect(prompt).toContain('差异化补丁任务队列');
    expect(prompt).toContain('禁止无关文件重写');
  });

  it('should decide rollback and refix on low-yield repeated issues', () => {
    const engine = new ExecutionEngine({ project_root: process.cwd() });
    expect(
      engine._shouldRollbackAndRefix({
        previousScore: 60,
        newScore: 58,
        repeatRate: 0.9,
        fileChangeEffective: false,
      }),
    ).toBe(true);
  });

  it('should include D3 quality metrics in execution summary', async () => {
    const engine = new ExecutionEngine({
      project_root: process.cwd(),
      max_concurrent_tasks: 1,
      max_review_cycles: 1,
      feature_flags: { controller: true, gate: true, parser: true, fingerprint: true },
    });
    engine.dispatcher.registerAgent('native-coder', () => ({
      name: 'native-coder',
      execute: async (task) => ({
        task_id: task.id,
        success: true,
        status: 'success',
        output: { files_created: ['main.py'], files_modified: [] },
      }),
      setPermissionClassifier: () => {},
    }));
    engine.dispatcher.registerAgent('native-reviewer', () => ({
      name: 'native-reviewer',
      execute: async () => ({
        task_id: 'review_t1',
        success: true,
        status: 'success',
        output: {
          score: 60,
          issues: [{ severity: 'CRITICAL', title: 'x', file: 'main.py', reason: 'same' }],
          summary: 'FAIL',
        },
      }),
      setPermissionClassifier: () => {},
    }));
    const plan = {
      plan_id: 'quality_metrics',
      project: { name: 'Quality Metrics' },
      tasks: [{ id: 't1', description: 'quality', type: 'create', agent: 'native-coder', dependencies: [] }],
      milestones: [{ id: 'm1', name: 'm1', tasks: ['t1'] }],
    };
    const result = await engine.execute(plan);
    expect(typeof result.summary.repeat_issue_rate).toBe('number');
    expect(result.summary).toHaveProperty('critical_clearance_time');
  });

  it('should emit abnormal retry burst alert', async () => {
    const engine = new ExecutionEngine({
      project_root: process.cwd(),
      observability: {
        structured_json_logs: false,
        alerts: { long_run_ms: 999999, retry_burst: 1, parse_failure_storm: 1 },
      },
    });
    const result = await engine._executeWithRetry(
      async () => {
        throw new Error('network timeout');
      },
      { maxRetries: 1, taskId: 't_retry', phase: 'review', context: {} },
    );
    expect(result.status).toBe('failed');
    expect(engine.alerts.some((a) => a.rule === 'ABNORMAL_RETRY_BURST')).toBe(true);
  });

  it('should aggregate alert category and rule stats in summary', () => {
    const engine = new ExecutionEngine({ project_root: process.cwd() });
    engine._emitAlert('PARSE_FAILURE_STORM', 'error', {
      error_category: 'parse',
      error_code: 'PARSE_FAILED',
      error_readable: 'parse storm',
    });
    engine._emitAlert('ABNORMAL_RETRY_BURST', 'warning', {
      error_category: 'retry',
      error_code: 'API_ERROR',
      error_readable: 'retry burst',
    });
    const summary = engine._generateSummary([], Date.now());
    expect(summary.alert_by_category.parse).toBe(1);
    expect(summary.alert_by_category.retry).toBe(1);
    expect(summary.alert_by_rule.PARSE_FAILURE_STORM).toBe(1);
    expect(summary.alert_by_rule.ABNORMAL_RETRY_BURST).toBe(1);
  });

  it('should record release observation and generate final evaluation report', async () => {
    const engine = new ExecutionEngine({
      project_root: process.cwd(),
      max_concurrent_tasks: 1,
      release: { enabled: true, observation_window_days: 7, auto_generate_report: true },
    });
    engine.dispatcher.registerAgent('native-coder', () => ({
      name: 'native-coder',
      execute: async (task) => ({
        task_id: task.id,
        success: true,
        status: 'success',
        output: { files_created: ['main.py'], files_modified: [] },
      }),
      setPermissionClassifier: () => {},
    }));
    engine.dispatcher.registerAgent('native-reviewer', () => ({
      name: 'native-reviewer',
      execute: async () => ({
        task_id: 'review_t1',
        success: true,
        status: 'success',
        output: { score: 95, issues: [], summary: 'OK' },
      }),
      setPermissionClassifier: () => {},
    }));
    const plan = {
      plan_id: 'release_observe',
      project: { name: 'Release Observe' },
      tasks: [{ id: 't1', description: 'release mode', type: 'create', agent: 'native-coder', dependencies: [] }],
      milestones: [{ id: 'm1', name: 'm1', tasks: ['t1'] }],
    };

    const result = await engine.execute(plan);
    expect(result.summary.release_observation).toBeDefined();
    expect(result.summary.release_observation.total_runs).toBeGreaterThan(0);
    expect(typeof result.summary.final_evaluation_report).toBe('string');
    expect(existsSync(result.summary.final_evaluation_report)).toBe(true);
    const reportContent = readFileSync(result.summary.final_evaluation_report, 'utf-8');
    expect(reportContent).toContain('告警分类分布');
    expect(reportContent).toContain('告警规则分布');
  });
});
