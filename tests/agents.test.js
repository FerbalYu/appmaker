import { AgentDispatcher } from '../src/agents/dispatcher.js';
import { NativeCoderAdapter } from '../src/agents/native-coder.js';
import { NativeReviewerAdapter } from '../src/agents/native-reviewer.js';
import { MinimaxMCPAdapter } from '../src/agents/minimax-mcp.js';
import { AssetScoutAdapter } from '../src/agents/asset-scout.js';
import { RainmakerAdapter } from '../src/agents/rainmaker.js';
import { MultiAgentThinker } from '../src/thinker.js';
import { ReviewInputGate } from '../src/review/review-input-gate.js';
import { ReviewerOutputParser } from '../src/review/reviewer-output-parser.js';
import { REVIEW_ERROR_CODES } from '../src/review/error-codes.js';

describe('Agents & Dispatcher', () => {
  it('should initialize NativeCoderAdapter and NativeReviewerAdapter', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const reviewer = new NativeReviewerAdapter({ api_key: 'test-key' });
    expect(coder.name).toBe('native-coder');
    expect(reviewer.name).toBe('native-reviewer');
  });

  it('should register and retrieve agent in dispatcher', () => {
    const dispatcher = new AgentDispatcher();
    const mockAgent = { execute: jest.fn() };
    dispatcher.registerAgent('test-agent', mockAgent);
    expect(dispatcher.agents.get('test-agent')).toBe(mockAgent);
    dispatcher.unregisterAgent('test-agent');
    expect(dispatcher.agents.get('test-agent')).toBeUndefined();
  });

  it('should extract JSON correctly in NativeCoderAdapter', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const result1 = coder._extractJSON('```json\n{"a":1}\n```');
    expect(result1.a).toBe(1);
    const result2 = coder._extractJSON('{"b":2}');
    expect(result2.b).toBe(2);
    const result3 = coder._extractJSON('Here is your json\n```\n{"c":3}\n```');
    expect(result3.c).toBe(3);
  });

  it('should build tools schema with explicit allowlist', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    coder.getTools = () => [
      {
        name: 'read_file',
        description: 'read',
        inputSchema: { type: 'object' },
      },
      {
        name: 'write_file',
        description: 'write',
        inputSchema: { type: 'object' },
      },
      {
        name: 'ask_user_question',
        description: 'interactive',
        inputSchema: { type: 'object' },
      },
    ];

    const schema = coder._getNativeToolsSchema();
    const names = schema.map((item) => item.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('write_file');
    expect(names).not.toContain('ask_user_question');
  });

  it('should resolve project scoped files and git cwd in _getProjectContext', async () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const calls = [];
    coder.executeTool = async (toolName, args) => {
      calls.push({ toolName, args });
      if (toolName === 'list_directory') {
        return { success: true, result: { items: [] } };
      }
      if (toolName === 'read_file' && args.file_path.endsWith('package.json')) {
        return {
          success: true,
          result: { content: '{"dependencies":{"a":"1.0.0"}}', size: 30 },
        };
      }
      if (toolName === 'read_file' && args.file_path.endsWith('README.md')) {
        return { success: true, result: { content: 'README', size: 6 } };
      }
      if (toolName === 'git_status') {
        return { success: true, result: { stdout: 'On branch main' } };
      }
      return { success: false };
    };

    await coder._getProjectContext('packages/demo');

    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'read_file',
          args: expect.objectContaining({ file_path: 'packages/demo/package.json' }),
        }),
        expect.objectContaining({
          toolName: 'read_file',
          args: expect.objectContaining({ file_path: 'packages/demo/README.md' }),
        }),
        expect.objectContaining({
          toolName: 'git_status',
          args: expect.objectContaining({ cwd: 'packages/demo' }),
        }),
      ]),
    );
  });

  it('should count repeated tool calls', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const counter = new Map();
    const call = { file_path: 'a.js', content: 'x' };
    expect(coder._recordToolCall(counter, 'write_file', call)).toBe(1);
    expect(coder._recordToolCall(counter, 'write_file', call)).toBe(2);
    expect(coder._recordToolCall(counter, 'write_file', call)).toBe(3);
    expect(coder._recordToolCall(counter, 'write_file', call)).toBe(4);
  });

  it('should include execution trace in formatted result', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const result = coder._formatResult(
      {
        task_id: 't1',
        success: true,
        summary: 'done',
        files_created: [],
        files_modified: ['src/a.js'],
        tool_calls_executed: 2,
        execution_trace: [
          {
            step: 0,
            tool: 'read_file',
            tool_call_id: 'tc_1',
            args_summary: '{"file_path":"a.js"}',
            success: true,
            duration_ms: 5,
            error: null,
          },
          {
            step: 1,
            tool: 'write_file',
            tool_call_id: 'tc_2',
            args_summary: '{"file_path":"a.js","content":"x"}',
            success: false,
            duration_ms: 8,
            error: 'denied',
          },
        ],
        duration_ms: 12,
      },
      Date.now(),
    );

    expect(result.output.execution_trace).toHaveLength(2);
    expect(result.output.execution_trace[0].tool).toBe('read_file');
    expect(result.output.execution_trace[0].tool_call_id).toBe('tc_1');
    expect(result.output.execution_trace[0].args_summary).toContain('file_path');
    expect(result.output.execution_trace[1].success).toBe(false);
  });

  it('should aggregate trace_summary in formatted result', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const result = coder._formatResult(
      {
        task_id: 't-trace',
        success: true,
        summary: 'ok',
        execution_trace: [
          { tool: 'read_file', batch_mode: 'parallel', tool_error_code: null },
          { tool: 'write_file', batch_mode: 'serial', tool_error_code: 'TOOL_EXECUTION_FAILED' },
          { tool: '__exit__' },
        ],
      },
      Date.now(),
    );

    expect(result.output.trace_summary).toEqual({
      total_events: 3,
      tool_errors: 1,
      skipped_events: 0,
      parallel_events: 1,
      serial_events: 1,
    });
  });

  it('should enforce tool result message budget in runtime', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const runtime = coder._createExecutionRuntime();

    const oversized = 'x'.repeat(13000);
    const truncated = coder._budgetToolResultContent(runtime, oversized);
    expect(truncated).toContain('truncated by budget');
    expect(runtime.totalToolMessageChars).toBeGreaterThan(0);

    runtime.totalToolMessageChars = 48000;
    const omitted = coder._budgetToolResultContent(runtime, { ok: true });
    expect(omitted).toContain('omitted due to total context budget limit');
  });

  it('should prefer change hints in _detectFileChanges when provided', async () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const changes = await coder._detectFileChanges('.', Date.now(), {
      created: new Set(['src/new.js']),
      modified: new Set(['src/existing.js']),
    });

    expect(changes.created).toEqual(['src/new.js']);
    expect(changes.modified).toEqual(['src/existing.js']);
  });

  it('should include stop_reason in formatted result', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const result = coder._formatResult(
      {
        task_id: 't-stop',
        success: true,
        summary: 'stopped',
        stop_reason: 'tool_calls_limit',
      },
      Date.now(),
    );
    expect(result.output.stop_reason).toBe('tool_calls_limit');
  });

  it('should summarize args with max length', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const summary = coder._summarizeArgs(
      { a: 'x'.repeat(300), b: 1 },
      40,
    );
    expect(summary.length).toBeLessThanOrEqual(43);
    expect(summary.endsWith('...')).toBe(true);
  });

  it('should enforce context budget when building prompt sections', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const projectContext = {
      structure: 'S'.repeat(500),
      files: ['a.js', 'b.js', 'c.js'],
      techStack: 'T'.repeat(500),
      gitStatus: 'G'.repeat(500),
      readmeSummary: 'R'.repeat(500),
    };

    const { sectionsText, budgetMeta } = coder._buildBudgetedContextSections(projectContext, 120);
    expect(sectionsText.length).toBeLessThanOrEqual(220); // includes section headers
    expect(budgetMeta.used).toBeLessThanOrEqual(120);
    expect(Object.values(budgetMeta.truncated).some(Boolean)).toBe(true);
  });

  it('should keep task requirement and core context in user prompt under budgeting', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const prompt = coder._buildUserPrompt(
      { description: '实现登录功能', subtasks: [] },
      {
        structure: '📁 src\n📄 app.js',
        files: ['app.js'],
        techStack: 'Node.js',
        gitStatus: 'clean',
        readmeSummary: 'summary',
      },
    );
    expect(prompt).toContain('## 项目需求');
    expect(prompt).toContain('实现登录功能');
    expect(prompt).toContain('## 项目结构');
  });

  it('should stop with tool_calls_limit when one-step calls exceed cap', async () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    coder._getProjectContext = async () => ({ files: [], structure: '', techStack: '' });
    coder._getNativeToolsSchema = () => [];
    coder._detectFileChanges = async () => ({ created: [], modified: [] });

    const overloadedCalls = Array.from({ length: 9 }).map((_, idx) => ({
      id: `tc_${idx}`,
      type: 'function',
      function: { name: 'read_file', arguments: '{}' },
    }));
    coder._requestCompletion = async () => ({
      ok: true,
      json: async () => ({
        usage: { total_tokens: 1 },
        choices: [{ message: { content: 'run tools', tool_calls: overloadedCalls } }],
      }),
    });

    const result = await coder.execute({
      id: 'task-limit',
      description: 'test limit',
      context: { project_root: '.' },
    });

    expect(result.status).toBe('success');
    expect(result.output.stop_reason).toBe('tool_calls_limit');
    expect(result.output.summary).toContain('超过限制');
  });

  it('should keep deterministic stop_reason for repeated/tool_errors/no_tool_calls', async () => {
    const makeBaseCoder = () => {
      const coder = new NativeCoderAdapter({ api_key: 'test-key' });
      coder._getProjectContext = async () => ({ files: [], structure: '', techStack: '' });
      coder._getNativeToolsSchema = () => [];
      coder._detectFileChanges = async () => ({ created: [], modified: [] });
      return coder;
    };

    const repeatedCoder = makeBaseCoder();
    repeatedCoder.executeTool = async () => ({ success: true, result: {} });
    repeatedCoder._requestCompletion = async () => ({
      ok: true,
      json: async () => ({
        usage: { total_tokens: 1 },
        choices: [
          {
            message: {
              content: 'repeat',
              tool_calls: [
                { id: 'tc_rep', type: 'function', function: { name: 'read_file', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
    });
    const repeatedResult = await repeatedCoder.execute({
      id: 'task-repeated',
      description: 'repeat',
      context: { project_root: '.' },
    });
    expect(repeatedResult.output.stop_reason).toBe('repeated_tool_call');

    const errorsCoder = makeBaseCoder();
    errorsCoder.executeTool = async () => ({ success: false, error: 'failed' });
    errorsCoder._requestCompletion = async () => ({
      ok: true,
      json: async () => ({
        usage: { total_tokens: 1 },
        choices: [
          {
            message: {
              content: 'errors',
              tool_calls: Array.from({ length: 6 }).map((_, i) => ({
                id: `tc_err_${i}`,
                type: 'function',
                function: { name: 'read_file', arguments: `{"file_path":"f${i}.js"}` },
              })),
            },
          },
        ],
      }),
    });
    const errorsResult = await errorsCoder.execute({
      id: 'task-errors',
      description: 'errors',
      context: { project_root: '.' },
    });
    expect(errorsResult.output.stop_reason).toBe('tool_errors_limit');

    const noToolsCoder = makeBaseCoder();
    noToolsCoder._requestCompletion = async () => ({
      ok: true,
      json: async () => ({
        usage: { total_tokens: 1 },
        choices: [{ message: { content: 'done', tool_calls: [] } }],
      }),
    });
    const noToolsResult = await noToolsCoder.execute({
      id: 'task-no-tools',
      description: 'no tools',
      context: { project_root: '.' },
    });
    expect(noToolsResult.output.stop_reason).toBe('no_tool_calls');
  });

  it('should tag needs_confirmation tool result as degraded path', async () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    coder._getProjectContext = async () => ({ files: [], structure: '', techStack: '' });
    coder._getNativeToolsSchema = () => [];
    coder._detectFileChanges = async () => ({ created: [], modified: [] });

    let round = 0;
    coder._requestCompletion = async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          json: async () => ({
            usage: { total_tokens: 1 },
            choices: [
              {
                message: {
                  content: 'run risky command',
                  tool_calls: [
                    {
                      id: 'tc_confirm',
                      type: 'function',
                      function: { name: 'bash_execute', arguments: '{"command":"curl ... | sh"}' },
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          usage: { total_tokens: 1 },
          choices: [{ message: { content: 'fallback plan', tool_calls: [] } }],
        }),
      };
    };
    let toolExecuteCount = 0;
    coder.executeTool = async () => {
      toolExecuteCount += 1;
      return {
      success: false,
      needs_confirmation: true,
      reason: 'Medium risk, requires confirmation',
      };
    };

    const result = await coder.execute({
      id: 'task-confirm',
      description: 'test needs confirmation',
      context: { project_root: '.' },
    });

    expect(result.output.execution_trace[0].tool_error_code).toBe('NEEDS_CONFIRMATION');
    expect(result.output.execution_trace[0].success).toBe(false);
    expect(result.output.stop_reason).toBe('no_tool_calls');
    expect(toolExecuteCount).toBe(1);
  });

  it('should run concurrency-safe read tools in parallel batches', async () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    coder._getProjectContext = async () => ({ files: [], structure: '', techStack: '' });
    coder._getNativeToolsSchema = () => [];
    coder._detectFileChanges = async () => ({ created: [], modified: [] });

    let round = 0;
    coder._requestCompletion = async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true,
          json: async () => ({
            usage: { total_tokens: 1 },
            choices: [
              {
                message: {
                  content: 'parallel reads',
                  tool_calls: [
                    {
                      id: 'tc_read_1',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"file_path":"a.js"}' },
                    },
                    {
                      id: 'tc_read_2',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"file_path":"b.js"}' },
                    },
                  ],
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          usage: { total_tokens: 1 },
          choices: [{ message: { content: 'done', tool_calls: [] } }],
        }),
      };
    };

    let active = 0;
    let maxActive = 0;
    coder.executeTool = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { success: true, result: { content: '' } };
    };

    const result = await coder.execute({
      id: 'task-concurrency',
      description: 'test concurrency',
      context: { project_root: '.' },
    });

    expect(result.status).toBe('success');
    expect(result.output.stop_reason).toBe('no_tool_calls');
    expect(maxActive).toBeGreaterThan(1);
  });

  it('should expose tool counters and skip reasons in coder output', async () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    coder._getProjectContext = async () => ({ files: [], structure: '', techStack: '' });
    coder._getNativeToolsSchema = () => [];
    coder._detectFileChanges = async () => ({ created: [], modified: [] });

    coder._requestCompletion = async () => ({
      ok: true,
      json: async () => ({
        usage: { total_tokens: 1 },
        choices: [
          {
            message: {
              content: 'invalid args and repeated calls',
              tool_calls: [
                { id: 'tc_bad', type: 'function', function: { name: 'read_file', arguments: '{"file_path":' } },
                { id: 'tc_rep_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                { id: 'tc_rep_2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                { id: 'tc_rep_3', type: 'function', function: { name: 'read_file', arguments: '{}' } },
                { id: 'tc_rep_4', type: 'function', function: { name: 'read_file', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
    });

    coder.executeTool = async () => ({ success: true, result: { content: '' } });

    const result = await coder.execute({
      id: 'task-counters',
      description: 'count stats',
      context: { project_root: '.' },
    });

    expect(result.output.stop_reason).toBe('repeated_tool_call');
    expect(result.output.tool_calls_total).toBe(5);
    expect(result.output.tool_calls_success).toBe(0);
    expect(result.output.tool_calls_failed).toBe(0);
    expect(result.output.tool_calls_skipped).toBeGreaterThanOrEqual(1);
    expect(result.output.skip_reasons.repeated_call).toBe(1);
    expect(result.output.steps_total).toBeGreaterThanOrEqual(1);
  });

  it('should record retry metrics when dispatcher retries and succeeds', async () => {
    const dispatcher = new AgentDispatcher({
      max_retries: 1,
      retry_delay: 1,
      request_timeout: 0,
    });

    let attempts = 0;
    dispatcher.registerAgent('retry-agent', () => ({
      execute: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('transient');
        }
        return { success: true, status: 'success' };
      },
      healthCheck: async () => true,
      getInfo: () => ({ name: 'retry-agent', type: 'test', capabilities: [] }),
    }));

    const result = await dispatcher.dispatch({
      id: 'retry-task-success',
      agent: 'retry-agent',
      description: 'retry test',
    });

    expect(result.status).toBe('success');
    const metrics = dispatcher.getMetrics().agents['retry-agent'];
    expect(metrics.retryAttempts).toBe(1);
    expect(metrics.retriedTasks).toBe(1);
  });

  it('should record retry metrics when dispatcher retries and still fails', async () => {
    const dispatcher = new AgentDispatcher({
      max_retries: 1,
      retry_delay: 1,
      request_timeout: 0,
    });

    dispatcher.registerAgent('retry-fail-agent', () => ({
      execute: async () => {
        throw new Error('always fails');
      },
      healthCheck: async () => true,
      getInfo: () => ({ name: 'retry-fail-agent', type: 'test', capabilities: [] }),
    }));

    await expect(
      dispatcher.dispatch({
        id: 'retry-task-fail',
        agent: 'retry-fail-agent',
        description: 'retry fail test',
      }),
    ).rejects.toThrow('failed');

    const metrics = dispatcher.getMetrics().agents['retry-fail-agent'];
    expect(metrics.retryAttempts).toBe(1);
    expect(metrics.retriedTasks).toBe(1);
    expect(metrics.failedTasks).toBe(1);
  });

  it('should filter reviewer tools by allowlist in tools description', () => {
    const reviewer = new NativeReviewerAdapter({ api_key: 'test-key' });
    reviewer.getTools = () => [
      { name: 'read_file', category: 'file_system', description: 'read' },
      { name: 'git_diff', category: 'git', description: 'git diff' },
      { name: 'ask_user_question', category: 'interactive', description: 'interactive' },
    ];

    const desc = reviewer._getToolsDescription();
    expect(desc).toContain('read_file');
    expect(desc).toContain('git_diff');
    expect(desc).not.toContain('ask_user_question');
  });

  it('should include reviewer stop_reason and execution_trace in formatted output', () => {
    const reviewer = new NativeReviewerAdapter({ api_key: 'test-key' });
    const result = reviewer._formatResult(
      {
        task_id: 'r1',
        score: 88,
        summary: 'ok',
        issues: [],
        files_reviewed: ['a.js'],
        stop_reason: 'completed',
        execution_trace: [{ tool: '__exit__', exit_stage: 'done' }],
      },
      Date.now(),
    );
    expect(result.output.stop_reason).toBe('completed');
    expect(result.output.execution_trace).toHaveLength(1);
  });

  it('should abort reviewer request signal on timeout and cleanup listeners', async () => {
    const reviewer = new NativeReviewerAdapter({ api_key: 'test-key' });
    const externalController = new AbortController();
    const { signal, cleanup } = reviewer._createRequestSignal(externalController.signal, 5);

    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(signal.aborted).toBe(true);

    cleanup();
    externalController.abort();
    expect(signal.aborted).toBe(true);
  });

  it('should reject empty review input by input gate', () => {
    const gate = new ReviewInputGate();
    const result = gate.validate({ filesToRead: [], fileContents: [] });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe(REVIEW_ERROR_CODES.EMPTY_INPUT);
    expect(result.error_readable).toContain('评审输入为空');
  });

  it('should classify file read failures as tool execution errors in input gate', () => {
    const gate = new ReviewInputGate();
    const result = gate.validate({ filesToRead: ['a.js'], fileContents: [] });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe(REVIEW_ERROR_CODES.TOOL_EXECUTION_FAILED);
    expect(result.error_category).toBe('tool');
  });

  it('should classify invalid reviewer output schema', () => {
    const parser = new ReviewerOutputParser({
      extractJSON: () => ({ summary: 'missing score', issues: [] }),
    });
    const result = parser.parse('ignored');
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe(REVIEW_ERROR_CODES.INVALID_SCHEMA);
    expect(result.error_category).toBe('schema');
    expect(result.error_readable).toContain('评审输出结构不合法');
  });

  it('should allow empty files review when gate feature flag is off', async () => {
    const reviewer = new NativeReviewerAdapter({
      api_key: 'test-key',
      feature_flags: { gate: false, parser: true },
    });
    reviewer._getGitDiff = async () => '';
    reviewer._requestCompletion = async () => ({
      ok: true,
      json: async () => ({
        usage: { total_tokens: 1 },
        choices: [{ message: { content: '{"score":90,"summary":"ok","issues":[]}' } }],
      }),
    });

    const result = await reviewer.execute({
      id: 'r_gate_off',
      description: 'review without files',
      files: [],
      context: { project_root: '.' },
    });

    expect(result.status).toBe('success');
    expect(result.output.score).toBe(90);
  });

  it('should allow task-level gate override without recreating adapter', async () => {
    const reviewer = new NativeReviewerAdapter({
      api_key: 'test-key',
      feature_flags: { gate: true, parser: true },
    });
    reviewer._getGitDiff = async () => '';
    reviewer._requestCompletion = async () => ({
      ok: true,
      json: async () => ({
        usage: { total_tokens: 1 },
        choices: [{ message: { content: '{"score":91,"summary":"ok","issues":[]}' } }],
      }),
    });

    const result = await reviewer.execute({
      id: 'r_gate_override',
      description: 'review without files',
      files: [],
      context: { project_root: '.', feature_flags: { gate: false } },
    });

    expect(result.status).toBe('success');
    expect(result.output.score).toBe(91);
  });

  it('should share base JSON extraction across other adapters', () => {
    const mcp = new MinimaxMCPAdapter({ api_key: 'test-key' });
    const scout = new AssetScoutAdapter({ api_key: 'test-key' });
    const rainmaker = new RainmakerAdapter({ api_key: 'test-key' });

    const input = '```json\n{"ok":true,"n":1}\n```';
    expect(mcp._extractJSON(input)).toEqual({ ok: true, n: 1 });
    expect(scout._extractJSON(input)).toEqual({ ok: true, n: 1 });
    expect(rainmaker._extractJSON(input)).toEqual({ ok: true, n: 1 });
  });

  it('should run rainmaker in state-probe-replan mode before final planning', async () => {
    const thinkerSpy = jest
      .spyOn(MultiAgentThinker.prototype, '_callAgent')
      .mockResolvedValueOnce(
        JSON.stringify({
          project: { name: 'rainmaker_probe_project', description: 'draft' },
          features: ['runability'],
          tasks: [{ id: 't1', type: 'modify', description: '补齐启动链路', files: ['src/index.js'] }],
          milestones: [{ id: 'm1', name: '可运行性', tasks: ['t1'] }],
          audit: { summary: 'draft audit', findings: [] },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          project: { name: 'rainmaker_probe_project', description: 'replanned' },
          features: ['runability', 'pitfall'],
          tasks: [{ id: 't1', type: 'modify', description: '先补齐缺失工件并修复启动链路' }],
          milestones: [{ id: 'm1', name: '先补洞后推进', tasks: ['t1'] }],
          audit: { summary: 'replanned audit', findings: [] },
        }),
      );

    const rainmaker = new RainmakerAdapter({ api_key: 'test-key' });
    rainmaker.getProjectContext = async () => ({ structure: 'mock structure' });
    rainmaker.stateProbe.collectProjectState = async () => ({
      captured_at: '2026-01-01T00:00:00.000Z',
      files: ['README.md'],
      directories: ['src'],
    });
    rainmaker.stateProbe.evaluateTaskState = async () => ({
      already_satisfied: false,
      reason: 'missing_required_artifacts',
      missing_artifacts: ['src/index.js'],
      required_artifacts: ['src/index.js'],
    });

    const result = await rainmaker.execute({
      id: 'rainmaker_probe',
      description: '先状态探针重订计划',
      context: { project_root: '.' },
    });

    expect(thinkerSpy).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success');
    expect(result.output.probe?.mode).toBe('state_probe_replan');
    expect(result.output.planning_stages?.probe_replanned).toBe(true);
    expect(result.output.plan.tasks[0].execution_mode).toBe('probe_replan');
    expect(result.output.plan.tasks[0].replan_plan?.strategy).toBe('rainmaker_probe_replan');
    expect(result.output.plan.probe?.project_state?.top_level_files).toBe(1);

    thinkerSpy.mockRestore();
  });
});
