import { normalizeCoderResult, normalizeReviewerResult } from '../src/contracts/agent-result.js';
import { normalizePlan, assertPlanShape } from '../src/contracts/plan.js';

describe('Agent result contracts', () => {
  it('should normalize successful native-coder result', () => {
    const result = normalizeCoderResult({
      task_id: 't1',
      agent: 'native-coder',
      status: 'success',
      output: {
        files_created: ['src/a.js'],
        files_modified: ['src/b.js'],
        summary: 'done',
        tool_calls_executed: 2,
      },
      metrics: { duration_ms: 10, tokens_used: 20 },
    });

    expect(result).toEqual(
      expect.objectContaining({
        task_id: 't1',
        agent: 'native-coder',
        status: 'success',
        success: true,
        error: '',
      }),
    );
    expect(result.output.files_created).toEqual(['src/a.js']);
    expect(result.output.files_modified).toEqual(['src/b.js']);
    expect(result.output.tool_calls_executed).toBe(2);
    expect(result.metrics.tokens_used).toBe(20);
  });

  it('should normalize native-coder handleError shape', () => {
    const result = normalizeCoderResult({
      success: false,
      agent: 'native-coder',
      error: { type: 'Error', message: 'API Key missing', stack: 'stack' },
    });

    expect(result.status).toBe('failed');
    expect(result.success).toBe(false);
    expect(result.error).toBe('API Key missing');
    expect(result.errors).toEqual(['API Key missing']);
    expect(result.output.files_created).toEqual([]);
    expect(result.output.files_modified).toEqual([]);
  });

  it('should normalize successful native-reviewer result', () => {
    const result = normalizeReviewerResult({
      task_id: 'review_t1',
      agent: 'native-reviewer',
      status: 'success',
      output: {
        score: 92,
        summary: 'good',
        issues: [],
        files_reviewed: ['src/a.js'],
      },
      metrics: { duration_ms: 8, tokens_used: 12 },
    });

    expect(result).toEqual(
      expect.objectContaining({
        task_id: 'review_t1',
        agent: 'native-reviewer',
        status: 'success',
        success: true,
        error: '',
        error_code: '',
      }),
    );
    expect(result.output.score).toBe(92);
    expect(result.output.summary).toBe('good');
    expect(result.output.files_reviewed).toEqual(['src/a.js']);
  });

  it('should normalize failed native-reviewer result with error code fields', () => {
    const result = normalizeReviewerResult({
      task_id: 'review_t1',
      status: 'failed',
      success: false,
      error: 'parse failed',
      error_code: 'PARSE_FAILED',
      output: {
        error_readable: '评审输出解析失败',
        error_category: 'parse',
      },
    });

    expect(result.status).toBe('failed');
    expect(result.success).toBe(false);
    expect(result.error).toBe('parse failed');
    expect(result.error_code).toBe('PARSE_FAILED');
    expect(result.output.score).toBe(0);
    expect(result.output.error_code).toBe('PARSE_FAILED');
    expect(result.output.error_readable).toBe('评审输出解析失败');
    expect(result.output.error_category).toBe('parse');
    expect(result.errors).toEqual(['parse failed']);
  });
});

describe('Plan contracts', () => {
  const validPlan = {
    plan_id: 'plan_test',
    created_at: '2026-01-01T00:00:00Z',
    requirement: '做一个登录页面',
    project: { name: 'login-page', description: 'Login page' },
    features: ['登录', '验证'],
    tasks: [
      {
        id: 't1',
        description: '创建登录组件',
        type: 'create',
        dependencies: [],
        agent: 'native-coder',
        estimated_tokens: 2000,
        estimated_minutes: 10,
      },
      {
        id: 't2',
        description: '编写登录测试',
        type: 'test',
        dependencies: ['t1'],
        agent: 'native-coder',
        estimated_tokens: 1500,
        estimated_minutes: 8,
      },
    ],
    milestones: [
      { id: 'm1', name: '核心功能', tasks: ['t1', 't2'] },
    ],
    metadata: {
      total_tasks: 2,
      estimated_tokens: 3500,
      total_minutes_estimate: 18,
    },
  };

  it('should normalize a valid plan', () => {
    const plan = normalizePlan(validPlan);
    expect(plan.plan_id).toBe('plan_test');
    expect(plan.project.name).toBe('login-page');
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].id).toBe('t1');
    expect(plan.tasks[0].type).toBe('create');
    expect(plan.tasks[1].dependencies).toEqual(['t1']);
    expect(plan.milestones).toHaveLength(1);
    expect(plan.milestones[0].tasks).toEqual(['t1', 't2']);
  });

  it('should filter out invalid dependencies', () => {
    const planData = {
      ...validPlan,
      tasks: [
        { id: 't1', description: 'a', type: 'create', dependencies: ['t3', 't99'] },
        { id: 't2', description: 'b', type: 'create', dependencies: ['t1'] },
      ],
    };
    const plan = normalizePlan(planData);
    expect(plan.tasks[0].dependencies).toEqual([]);
    expect(plan.tasks[1].dependencies).toEqual(['t1']);
  });

  it('should fill defaults on minimal plan', () => {
    const minimal = {
      tasks: [{ id: 't1', description: 'do it' }],
      milestones: [],
    };
    const plan = normalizePlan(minimal);
    expect(plan.plan_id).toMatch(/^plan_\d+$/);
    expect(plan.project.name).toBe('unknown-project');
    expect(plan.tasks[0].type).toBe('create');
    expect(plan.tasks[0].dependencies).toEqual([]);
    expect(plan.tasks[0].estimated_tokens).toBe(2000);
    expect(plan.features).toEqual([]);
  });

  it('should throw for null plan', () => {
    expect(() => assertPlanShape(null)).toThrow('not an object');
  });

  it('should throw for plan without tasks', () => {
    expect(() => assertPlanShape({ milestones: [] })).toThrow('tasks is not an array');
  });

  it('should throw for plan with empty tasks', () => {
    expect(() => assertPlanShape({ tasks: [], milestones: [] })).toThrow('tasks array is empty');
  });

  it('should throw for plan without milestones', () => {
    expect(() => assertPlanShape({ tasks: [{ id: 't1', description: 'x' }] })).toThrow(
      'milestones is not an array',
    );
  });

  it('should throw for task missing id', () => {
    expect(() =>
      assertPlanShape({ tasks: [{ description: 'no id' }], milestones: [] }),
    ).toThrow('missing id');
  });

  it('should throw for task missing description', () => {
    expect(() =>
      assertPlanShape({ tasks: [{ id: 't1' }], milestones: [] }),
    ).toThrow('missing description');
  });

  it('should filter milestone tasks to valid task IDs', () => {
    const planData = {
      ...validPlan,
      milestones: [
        { id: 'm1', name: 'x', tasks: ['t1', 't99', 't2'] },
      ],
    };
    const plan = normalizePlan(planData);
    expect(plan.milestones[0].tasks).toEqual(['t1', 't2']);
  });
});
