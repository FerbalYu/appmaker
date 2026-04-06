/**
 * Native Coder Adapter - AI 编程 Agent
 *
 * 集成 UniversalToolbox，支持：
 * - 文件读写工具
 * - Bash 命令执行
 * - Git 操作
 * - LSP 代码分析
 * - 包管理器
 */
import { AgentAdapter } from './base.js';
import { jsonrepair } from 'jsonrepair';
import { promises as fs } from 'fs';
import path from 'path';
import {
  LOOP_STATE,
  STOP_REASON,
  createExecutionGuard,
  isTerminalStopReason,
  requestStop,
} from './runtime/guard.js';
import {
  buildBudgetedContextSections,
  budgetText,
  fitListWithinBudget,
} from './runtime/context-builder.js';
import {
  executeBatchedToolCalls,
  executeSingleToolCall,
  parseToolCallArgs,
  prepareToolCalls,
  TOOL_SKIP_REASONS,
} from './runtime/tool-orchestrator.js';
import { createTraceRecorder } from './runtime/trace.js';
import { createDefaultStopHooks, createStopHookRunner } from './runtime/stop-hooks.js';

const NATIVE_CODER_CONFIG = {
  name: 'native-coder',
  type: 'api',
  capabilities: ['coding', 'refactoring', 'file-editing', 'testing', 'git-operations'],
};
const TOOL_ALLOWLIST = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'glob_pattern',
  'write_file',
  'edit_file',
  'delete_file',
  'bash_execute',
  'npm_run',
  'npm_install',
  'git_status',
  'git_diff',
]);
const MAX_SAME_TOOL_CALL = 3;
const MAX_STEPS = 15;
const MAX_TOOL_CALLS_PER_STEP = 8;
const MAX_TOOL_ERRORS_TOTAL = 6;
const MAX_TOOL_MESSAGE_CHARS = 12000;
const MAX_TOTAL_TOOL_MESSAGE_CHARS = 48000;
const CONTEXT_BUDGET_TOTAL = 8000;
const CONTEXT_SECTION_LIMITS = {
  structure: 2400,
  files: 1200,
  techStack: 800,
  gitStatus: 1800,
  readmeSummary: 1800,
};
export class NativeCoderAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...NATIVE_CODER_CONFIG, ...config });
    this.apiKey = process.env.OPENAI_API_KEY || process.env.MINIMAX_API_KEY || config.api_key;
    this.apiHost =
      process.env.OPENAI_API_BASE ||
      process.env.MINIMAX_API_HOST ||
      config.api_host ||
      'https://api.minimaxi.com';
    this.model =
      process.env.OPENAI_MODEL ||
      process.env.MINIMAX_API_MODEL ||
      config.model ||
      'MiniMax-Text-01';

    if (config.project_root) {
      this.toolbox.config.workspace_root = config.project_root;
    }
  }

  async healthCheck() {
    return !!this.apiKey;
  }

  /**
   * 获取原生工具定义 Schema
   * @private
   */
  _getNativeToolsSchema() {
    const filteredTools = this.getTools().filter((t) => TOOL_ALLOWLIST.has(t.name));

    return filteredTools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  _joinProjectPath(projectRoot, fileName) {
    if (!projectRoot || projectRoot === '.') return fileName;
    const normalizedRoot = projectRoot.replace(/\\/g, '/');
    return path.posix.join(normalizedRoot, fileName);
  }

  _recordToolCall(callCountMap, toolName, args) {
    const key = `${toolName}:${JSON.stringify(args || {})}`;
    const count = (callCountMap.get(key) || 0) + 1;
    callCountMap.set(key, count);
    return count;
  }

  _summarizeArgs(args, maxLen = 180) {
    try {
      const text = JSON.stringify(args || {});
      if (text.length <= maxLen) return text;
      return `${text.substring(0, maxLen)}...`;
    } catch {
      return '[Unserializable args]';
    }
  }

  _truncateTextByBudget(text, maxChars) {
    return budgetText(text, maxChars);
  }

  _fitListWithinBudget(items, maxChars, separator = ', ') {
    return fitListWithinBudget(items, maxChars, separator);
  }

  _buildBudgetedContextSections(projectContext, totalBudget = CONTEXT_BUDGET_TOTAL) {
    return buildBudgetedContextSections(projectContext, CONTEXT_SECTION_LIMITS, totalBudget);
  }

  _buildSystemPrompt() {
    return `你是一个资深的 AI 全栈工程师，负责根据需求编写高质量代码。
你工作在全自动环境，输出的代码必须能通过严格的代码审查（评审阈值 85 分）。

## 重要原则
1. 错误处理 - 所有可能失败的操作必须 try-catch，错误要记录和报告
2. 输入验证 - 验证所有外部输入，不信任任何用户数据
3. 安全性 - 防止 XSS、SQL 注入、命令注入等安全漏洞
4. 代码可读性 - 使用有意义的变量名，添加必要注释
5. 完整性 - 不要留 TODO，确保功能完整可运行
6. 严禁 Bash 穿透写文件 - 当你要创建或更改代码、文档时，**必须且只能使用 \`write_file\` 或 \`edit_file\` 工具**。绝对禁止使用 \`bash_execute\` 执行 echo/cat 等命令输出文件，否则系统判定为你严重失职！
7. 拒绝交白卷 - 本次任务中包含必须执行的【明确子任务】，你必须主动使用工具创建、修改文件以完成子任务。**绝对不允许仅回复"了解逻辑"而没有任何 tool_calls。**
8. 权限降级策略 - 若工具返回 \`needs_confirmation: true\`，你必须立即切换为低风险方案：只读分析、生成可应用 patch 建议、列出需要人工确认的命令和原因，禁止原地重复调用同一高风险工具。

你已经接入了全自动开发动作执行平台，当你需要读取/修改文件、执行命令时，请直接主动调用工具 (Tools)。请尽可能结合当前上下文环境做出符合项目技术栈的直接干预和修改！`;
  }

  _buildSubtasksSection(task) {
    if (!task.subtasks || task.subtasks.length === 0) return '';
    return `\n## 明确子任务 (必须执行)\n${task.subtasks.map((st, i) => `${i + 1}. ${st}`).join('\n')}\n`;
  }

  _buildUserPrompt(task, projectContext) {
    const subtasksSection = this._buildSubtasksSection(task);
    const goalInvariant = task.context?.goal_invariant || task.goal || '';
    const goalSection = goalInvariant
      ? `\n## 目标不变约束\n- 最终业务目标: ${goalInvariant}\n- 允许调整实现步骤，但禁止偏离最终目标。\n`
      : '';
    const replanSection =
      task.execution_mode === 'probe_replan' && task.replan_plan
        ? `\n## 动态重规划执行分层\n${(task.replan_plan.phases || [])
            .map((phase, index) => `${index + 1}. ${phase.name}: ${phase.objective}`)
            .join('\n')}\n`
        : '';
    const { sectionsText, budgetMeta } = this._buildBudgetedContextSections(projectContext);
    projectContext.budgetMeta = budgetMeta;
    return `## 项目需求
${task.description}
${subtasksSection}
${goalSection}
${replanSection}
${sectionsText}

请使用工具完成代码编写任务，直接输出 JSON 格式的 tool_calls。`;
  }

  _createExecutionRuntime() {
    const traceRecorder = createTraceRecorder();
    const stopHooks = createDefaultStopHooks(this.config || {});
    return {
      finalContent: '代码编写完毕。',
      executedCount: 0,
      totalTokens: 0,
      toolErrorsTotal: 0,
      stopReason: STOP_REASON.COMPLETED,
      loopState: LOOP_STATE.RUNNING,
      exitStage: 'init',
      exitNote: 'started',
      executionTrace: traceRecorder.traces,
      traceRecorder,
      toolCallCounter: new Map(),
      totalToolMessageChars: 0,
      consecutiveToolFailures: 0,
      stepStats: {
        total: 0,
        withToolCalls: 0,
        withoutToolCalls: 0,
      },
      toolStats: {
        total: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        skip_reasons: {},
      },
      fileChangeHints: {
        created: new Set(),
        modified: new Set(),
      },
      guard: createExecutionGuard(),
      runStopHooks: createStopHookRunner(stopHooks),
    };
  }

  _incrementSkipReason(runtime, reason, count = 1) {
    if (!reason) return;
    runtime.toolStats.skip_reasons[reason] = (runtime.toolStats.skip_reasons[reason] || 0) + count;
  }

  async _runStopHooks(runtime, payload = {}) {
    if (!runtime.runStopHooks) return false;
    const hookResult = await runtime.runStopHooks({ runtime, ...payload });
    if (!hookResult?.stop) return false;
    this._requestStop(runtime, {
      reason: hookResult.reason || STOP_REASON.COMPLETED,
      content: hookResult.content || runtime.finalContent,
      stage: hookResult.stage || 'hook',
      note: hookResult.note || 'stopped by hook',
      expectedGeneration: payload.expectedGeneration ?? null,
    });
    if (hookResult.trace) {
      this._traceToolExecution(runtime.executionTrace, hookResult.trace);
    } else {
      this._traceToolExecution(runtime.executionTrace, {
        step: payload.step ?? -1,
        tool: '__stop_hook__',
        tool_call_id: null,
        args_summary: JSON.stringify({
          reason: hookResult.reason || 'hook_stop',
        }),
        success: false,
        duration_ms: 0,
        api_round_trip_ms: payload.apiRoundTripMs || 0,
        tool_error_code: 'HOOK_STOP',
        error: hookResult.note || hookResult.reason || 'Hook requested stop',
      });
    }
    return true;
  }

  _normalizeWorkspaceRelativePath(projectRoot, filePath) {
    if (!filePath || typeof filePath !== 'string') return null;
    const normalizedInput = filePath.replace(/\\/g, '/');
    const normalizedRoot = (projectRoot || '.').replace(/\\/g, '/');

    if (normalizedInput.startsWith('/') || /^[A-Za-z]:\//.test(normalizedInput)) {
      const absoluteRoot = path.resolve(normalizedRoot).replace(/\\/g, '/');
      const absoluteInput = path.resolve(normalizedInput).replace(/\\/g, '/');
      if (absoluteInput.startsWith(`${absoluteRoot}/`)) {
        return path.posix.relative(absoluteRoot, absoluteInput);
      }
      return null;
    }

    return normalizedInput.replace(/^\.\/+/, '');
  }

  _recordFileChangeHint(runtime, tool, args, toolResultObj, projectRoot) {
    if (!toolResultObj || toolResultObj.success === false) return;

    const writeLikeTools = new Set(['write_file', 'edit_file']);
    if (!writeLikeTools.has(tool)) return;

    const relativePath = this._normalizeWorkspaceRelativePath(projectRoot, args?.file_path);
    if (!relativePath) return;
    runtime.fileChangeHints.modified.add(relativePath);
  }

  _budgetToolResultContent(runtime, content) {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const current = runtime.totalToolMessageChars;
    const remaining = Math.max(0, MAX_TOTAL_TOOL_MESSAGE_CHARS - current);
    if (remaining <= 0) {
      return JSON.stringify({
        success: false,
        error: 'Tool result omitted due to total context budget limit',
      });
    }
    if (text.length <= Math.min(MAX_TOOL_MESSAGE_CHARS, remaining)) {
      runtime.totalToolMessageChars += text.length;
      return text;
    }
    const limited = Math.min(MAX_TOOL_MESSAGE_CHARS, remaining);
    const truncated = `${text.substring(0, Math.max(0, limited - 80))}\n... (tool result truncated by budget)`;
    runtime.totalToolMessageChars += truncated.length;
    return truncated;
  }

  _createLoopGuard() {
    return createExecutionGuard();
  }

  _isTerminalStopReason(reason) {
    return isTerminalStopReason(reason);
  }

  _requestStop(runtime, { reason, content, stage = 'loop', note = '', expectedGeneration = null }) {
    const accepted = requestStop(runtime.guard, {
      reason,
      stage,
      note,
      expectedGeneration,
    });
    if (!accepted) {
      return false;
    }
    runtime.loopState = runtime.guard.state;
    runtime.stopReason = runtime.guard.stopReason;
    if (content) {
      runtime.finalContent = content;
    }
    runtime.exitStage = runtime.guard.exitStage;
    runtime.exitNote = runtime.guard.exitNote;
    return true;
  }

  _appendExitTrace(runtime) {
    runtime.traceRecorder.appendExitTrace(runtime.guard);
  }

  _traceToolExecution(executionTrace, trace) {
    executionTrace.push({
      exit_stage: trace.exit_stage || null,
      exit_note: trace.exit_note || null,
      guard_generation: trace.guard_generation || null,
      ...trace,
    });
  }

  _normalizeNeedsConfirmationResult(toolResultObj) {
    if (!toolResultObj?.needs_confirmation) return toolResultObj;
    return {
      success: false,
      needs_confirmation: true,
      error: toolResultObj.reason || 'Tool execution requires confirmation',
      degraded_plan: [
        '先执行只读工具收集证据',
        '输出可应用 patch 建议（不直接执行高风险命令）',
        '列出需要人工确认的命令及风险理由',
      ],
    };
  }

  /**
   * 使用工具执行文件操作
   * @private
   */
  async _executeFileOperations(fileOps) {
    const results = [];
    for (const op of fileOps) {
      let result;
      switch (op.action) {
        case 'create':
        case 'write':
        case 'modify':
          result = await this.executeTool('write_file', {
            file_path: op.path,
            content: op.content,
            append: false,
          });
          break;
        case 'delete':
          result = await this.executeTool('delete_file', {
            path: op.path,
            recursive: op.recursive || false,
          });
          break;
        case 'read':
          result = await this.executeTool('read_file', {
            file_path: op.path,
          });
          break;
        default:
          result = { success: false, error: `Unknown action: ${op.action}` };
      }
      results.push({ path: op.path, action: op.action, result });
    }
    return results;
  }

  /**
   * 获取项目上下文
   * @private
   */
  async _getProjectContext(projectRoot) {
    const context = { files: [], structure: '', techStack: '', truncation: {} };

    const listResult = await this.executeTool('list_directory', {
      dir_path: projectRoot || '.',
      include_hidden: false,
    });

    if (listResult.success && listResult.result.items) {
      const allFiles = listResult.result.items.filter((i) => i.type === 'file').map((f) => f.name);
      const fittedFiles = this._fitListWithinBudget(allFiles, CONTEXT_SECTION_LIMITS.files);
      context.files = fittedFiles.value;
      context.truncation.files = fittedFiles.truncated;

      const structureText = listResult.result.items
        .map((i) => `${i.type === 'directory' ? '📁' : '📄'} ${i.name}`)
        .join('\n');
      const fittedStructure = this._truncateTextByBudget(
        structureText,
        CONTEXT_SECTION_LIMITS.structure,
      );
      context.structure = fittedStructure.value;
      context.truncation.structure = fittedStructure.truncated;
    }

    const packageResult = await this.executeTool('read_file', {
      file_path: this._joinProjectPath(projectRoot, 'package.json'),
    });
    if (packageResult.success) {
      try {
        const pkg = JSON.parse(packageResult.result.content);
        const techStack = `Node.js/${pkg.engines?.node || 'unknown'} | ${Object.keys(
          pkg.dependencies || {},
        )
          .slice(0, 5)
          .join(', ')}`;
        const fittedTechStack = this._truncateTextByBudget(techStack, CONTEXT_SECTION_LIMITS.techStack);
        context.techStack = fittedTechStack.value;
        context.truncation.techStack = fittedTechStack.truncated;
      } catch (_) {
        /* ignore parse errors */
      }
    }

    const readmeResult = await this.executeTool('read_file', {
      file_path: this._joinProjectPath(projectRoot, 'README.md'),
    });
    if (readmeResult.success) {
      const fittedReadme = this._truncateTextByBudget(
        readmeResult.result.content || '',
        CONTEXT_SECTION_LIMITS.readmeSummary,
      );
      context.readmeSummary = fittedReadme.value;
      context.truncation.readmeSummary = fittedReadme.truncated;
    }

    const gitResult = await this.executeTool('git_status', { cwd: projectRoot || '.' });
    if (gitResult.success) {
      const fittedGitStatus = this._truncateTextByBudget(
        gitResult.result.stdout || 'Clean',
        CONTEXT_SECTION_LIMITS.gitStatus,
      );
      context.gitStatus = fittedGitStatus.value;
      context.truncation.gitStatus = fittedGitStatus.truncated;
    }

    return context;
  }

  async execute(task) {
    const startTime = Date.now();
    try {
      if (!this.apiKey) {
        throw new Error(
          'API Key missing. Please set OPENAI_API_KEY or MINIMAX_API_KEY for native-coder',
        );
      }

      const projectRoot = task.context?.project_root || '.';
      if (projectRoot) {
        this.toolbox.config.workspace_root = projectRoot;
      }
      const projectContext = await this._getProjectContext(projectRoot);
      const toolsSchema = this._getNativeToolsSchema();

      const systemPrompt = this._buildSystemPrompt();
      const userPrompt = this._buildUserPrompt(task, projectContext);

      const endpoint = this.apiHost.endsWith('/v1')
        ? `${this.apiHost}/chat/completions`
        : `${this.apiHost}/v1/chat/completions`;

      console.log(`[${this.name}] 请求原生 API 进行编程任务... (Model: ${this.model})`);

      let messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      const runtime = this._createExecutionRuntime();
      const externalSignal = task.context?.abortController?.signal || task.context?.abortSignal;

      for (let step = 0; step < MAX_STEPS; step++) {
        runtime.stepStats.total += 1;
        const stepGeneration = runtime.guard.generation;
        if (externalSignal?.aborted) {
          this._requestStop(runtime, {
            reason: STOP_REASON.EXTERNAL_ABORT,
            content: '任务被外部取消信号中断。',
            stage: 'pre_request',
            note: 'external abort signal detected',
            expectedGeneration: stepGeneration,
          });
          break;
        }

        const payload = {
          model: this.model,
          messages,
          tools: toolsSchema,
          temperature: 0.1,
        };

        // Support for Minimax Native Reasoning Split
        // This prevents <think> tags from disrupting tool calls or content text
        if (this.apiHost.includes('minimaxi.com')) {
          payload.extra_body = { reasoning_split: true };
        }

        const apiStartedAt = Date.now();
        let res;
        try {
          res = await this._requestCompletion(endpoint, payload, externalSignal);
        } catch (error) {
          this._requestStop(runtime, {
            reason: STOP_REASON.API_ERROR,
            stage: 'request',
            note: `request exception: ${error.message}`,
            expectedGeneration: stepGeneration,
          });
          throw error;
        }
        const apiRoundTripMs = Date.now() - apiStartedAt;

        if (!res.ok) {
          const errorText = await res.text();
          this._requestStop(runtime, {
            reason: STOP_REASON.API_ERROR,
            stage: 'request',
            note: `http ${res.status}`,
            expectedGeneration: stepGeneration,
          });
          throw new Error(`API Error ${res.status}: ${errorText}`);
        }

        const data = await res.json();
        runtime.totalTokens += data.usage?.total_tokens || 0;

        if (data.base_resp && data.base_resp.status_code !== 0) {
          throw new Error(
            `MiniMax API Error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`,
          );
        } else if (data.error) {
          throw new Error(`API Error ${data.error.code || data.error.type}: ${data.error.message}`);
        }

        if (!data.choices || data.choices.length === 0) {
          throw new Error(`API 响应结构异常: ${JSON.stringify(data).substring(0, 200)}`);
        }

        const message = data.choices[0].message;

        // Emit Reasoning Process as Telemetry
        let cleanedContent = message.content || '';
        if (message.reasoning_details && message.reasoning_details.length > 0) {
          const reasoningText = message.reasoning_details.map((r) => r.text).join('\n');
          if (typeof this.emit === 'function') {
            this.emit('action', { type: 'think', content: reasoningText.trim() });
          }
        } else {
          // Fallback for non-Minimax models or if reasoning_split is not supported
          const thinkMatch = cleanedContent.match(/<think>([\s\S]*?)<\/think>/i);
          if (thinkMatch && typeof this.emit === 'function') {
            this.emit('action', { type: 'think', content: thinkMatch[1].trim() });
          }
        }

        // Strip <think> chunks from cleanedContent
        cleanedContent = cleanedContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        // Emit the LLM's direct message intent to the user
        if (cleanedContent && typeof this.emit === 'function') {
          this.emit('action', { type: 'think', content: cleanedContent });
        }

        messages.push(message);

        const nativeToolCalls = message.tool_calls || [];
        runtime.toolStats.total += nativeToolCalls.length;

        if (nativeToolCalls.length === 0) {
          runtime.stepStats.withoutToolCalls += 1;
          this._requestStop(runtime, {
            reason: STOP_REASON.NO_TOOL_CALLS,
            content: message.content || runtime.finalContent,
            stage: 'model_output',
            note: 'no native tool calls returned',
            expectedGeneration: stepGeneration,
          });
          if (step === 0) {
            this._log &&
              this._log(
                'INFO',
                `[${this.name}] ⚠️ 未检测到原生的 tool_calls。模型回复: ${message.content?.substring(0, 100)}...`,
              );
          }
          break; // 跳出大循环
        }
        runtime.stepStats.withToolCalls += 1;

        let shouldStopLoop = false;
        if (nativeToolCalls.length > 0 && projectRoot) {
          runtime.executedCount += nativeToolCalls.length;
          const { preparedCalls, shouldStop, skipped, skipReasons } = prepareToolCalls({
            nativeToolCalls,
            maxToolCallsPerStep: MAX_TOOL_CALLS_PER_STEP,
            maxSameToolCall: MAX_SAME_TOOL_CALL,
            recordToolCall: (tool, args) => this._recordToolCall(runtime.toolCallCounter, tool, args),
            parseArgs: (toolCall) =>
              parseToolCallArgs({
                toolCall,
                step,
                apiRoundTripMs,
                summarizeArgs: (args) => this._summarizeArgs(args),
                repairJson: (raw) => JSON.parse(jsonrepair(raw)),
              }),
            onLimitExceeded: (count) => {
              this._requestStop(runtime, {
                reason: STOP_REASON.TOOL_CALLS_LIMIT,
                content: `单轮工具调用数超过限制(${MAX_TOOL_CALLS_PER_STEP})，已提前停止。`,
                stage: 'tool_dispatch',
                note: `nativeToolCalls=${count}`,
                expectedGeneration: stepGeneration,
              });
              this._traceToolExecution(runtime.executionTrace, {
                step,
                tool: '__loop_guard__',
                tool_call_id: null,
                args_summary: JSON.stringify({ tool_calls: count }),
                success: false,
                duration_ms: 0,
                api_round_trip_ms: apiRoundTripMs,
                tool_error_code: 'TOOL_CALLS_LIMIT',
                error: `Tool calls in one step exceeded limit: ${count}`,
              });
              shouldStopLoop = true;
            },
            onInvalidArgs: (toolCall, parsedArgs) => {
              this._traceToolExecution(runtime.executionTrace, parsedArgs.errorTrace);
              messages.push(parsedArgs.toolMessage);
              runtime.toolErrorsTotal += parsedArgs.toolErrorsDelta;
              console.error(
                `[${this.name}] Repair 解析失败，跳过工具调用: ${toolCall.function.name}`,
              );
            },
            onRepeatedCall: (toolCall, tool, args) => {
              this._requestStop(runtime, {
                reason: STOP_REASON.REPEATED_TOOL_CALL,
                content: `检测到重复工具调用，已提前停止: ${tool}`,
                stage: 'tool_dispatch',
                note: `repeated tool call: ${tool}`,
                expectedGeneration: stepGeneration,
              });
              this._traceToolExecution(runtime.executionTrace, {
                step,
                tool,
                tool_call_id: toolCall.id,
                args_summary: this._summarizeArgs(args),
                success: false,
                duration_ms: 0,
                api_round_trip_ms: apiRoundTripMs,
                tool_error_code: 'REPEATED_TOOL_CALL',
                error: `Repeated tool call detected: ${tool}`,
              });
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({
                  success: false,
                  error: `Repeated tool call detected: ${tool}`,
                }),
              });
              shouldStopLoop = true;
            },
          });

          if (skipped > 0) {
            runtime.toolStats.skipped += skipped;
            for (const [reason, count] of Object.entries(skipReasons || {})) {
              this._incrementSkipReason(runtime, reason, count);
            }
          }

          if (shouldStop || shouldStopLoop) {
            break;
          }

          await executeBatchedToolCalls({
            preparedCalls,
            executeSingleCall: (call) =>
              executeSingleToolCall({
                call,
                step,
                apiRoundTripMs,
                executeTool: (toolName, args, toolCallId) =>
                  this.executeTool(toolName, args, toolCallId),
                normalizeResult: (result) => this._normalizeNeedsConfirmationResult(result),
                summarizeArgs: (args) => this._summarizeArgs(args),
                onFileSaved: (filePath) => {
                  console.log(`[${this.name}] 已保存文件: ${filePath}`);
                },
                onCommandExecuted: (toolName, success) => {
                  console.log(`[${this.name}] 命令执行: ${toolName}`, success ? '✓' : '✗');
                },
              }),
            onCallSettled: async (call, singleRun, mode) => {
              runtime.toolErrorsTotal += singleRun.toolErrorsDelta;
              if (singleRun.toolResultObj?.success === false) {
                runtime.toolStats.failed += 1;
                runtime.consecutiveToolFailures += 1;
              } else {
                runtime.toolStats.success += 1;
                runtime.consecutiveToolFailures = 0;
              }
              this._recordFileChangeHint(
                runtime,
                call.tool,
                call.args,
                singleRun.toolResultObj,
                projectRoot,
              );
              this._traceToolExecution(runtime.executionTrace, {
                ...singleRun.trace,
                batch_mode: mode,
              });
              messages.push({
                role: 'tool',
                tool_call_id: call.toolCall.id,
                content: this._budgetToolResultContent(runtime, singleRun.toolResultObj),
              });
              if (runtime.toolErrorsTotal >= MAX_TOOL_ERRORS_TOTAL) {
                this._requestStop(runtime, {
                  reason: STOP_REASON.TOOL_ERRORS_LIMIT,
                  content: `工具失败次数达到上限(${MAX_TOOL_ERRORS_TOTAL})，已提前停止。`,
                  stage: 'tool_result',
                  note: `toolErrorsTotal=${runtime.toolErrorsTotal}`,
                  expectedGeneration: stepGeneration,
                });
                shouldStopLoop = true;
                return true;
              }
              const hookStopped = await this._runStopHooks(runtime, {
                step,
                apiRoundTripMs,
                expectedGeneration: stepGeneration,
              });
              if (hookStopped) {
                shouldStopLoop = true;
                return true;
              }
              return false;
            },
            onCallSkipped: async (call, reason, info = {}) => {
              runtime.toolStats.skipped += 1;
              this._incrementSkipReason(runtime, reason || TOOL_SKIP_REASONS.STOP_REQUESTED, 1);
              const skippedContent = {
                success: false,
                skipped: true,
                reason: reason || TOOL_SKIP_REASONS.STOP_REQUESTED,
                error: info?.error || 'Tool call skipped',
              };
              this._traceToolExecution(runtime.executionTrace, {
                step,
                tool: call.tool,
                tool_call_id: call.toolCall.id,
                args_summary: this._summarizeArgs(call.args),
                success: false,
                duration_ms: 0,
                api_round_trip_ms: apiRoundTripMs,
                tool_error_code: 'TOOL_SKIPPED',
                error: skippedContent.error,
              });
              messages.push({
                role: 'tool',
                tool_call_id: call.toolCall.id,
                content: JSON.stringify(skippedContent),
              });
            },
            shouldCascadeCancel: (_call, singleRun) => {
              if (!singleRun?.toolResultObj || singleRun.toolResultObj.success !== false) {
                return false;
              }
              const code = singleRun.trace?.tool_error_code || '';
              if (code === 'NEEDS_CONFIRMATION') return false;
              return Boolean(singleRun.toolResultObj?.critical || singleRun.toolResultObj?.cascade_cancel);
            },
            isStopRequested: () => shouldStopLoop,
          });
        }
        if (shouldStopLoop) {
          break;
        }
      }
      if (runtime.loopState === LOOP_STATE.RUNNING) {
        this._requestStop(runtime, {
          reason: STOP_REASON.MAX_STEPS_REACHED,
          content: `达到最大迭代轮次(${MAX_STEPS})，任务提前结束。`,
          stage: 'loop',
          note: 'max steps reached',
        });
      }
      if (!this._isTerminalStopReason(runtime.stopReason)) {
        this._requestStop(runtime, {
          reason: STOP_REASON.COMPLETED,
          stage: 'loop',
          note: 'fallback terminal reason',
        });
      }
      runtime.loopState = LOOP_STATE.FINISHED;
      this._appendExitTrace(runtime);

      const { created: filesCreated, modified: filesModified } = await this._detectFileChanges(
        projectRoot,
        startTime,
        runtime.fileChangeHints,
      );

      return this._formatResult(
        {
          task_id: task.id,
          success: true,
          summary: runtime.finalContent,
          files_created: filesCreated,
          files_modified: filesModified,
          tool_calls_executed: runtime.executedCount,
          tool_calls_total: runtime.toolStats.total,
          tool_calls_success: runtime.toolStats.success,
          tool_calls_failed: runtime.toolStats.failed,
          tool_calls_skipped: runtime.toolStats.skipped,
          skip_reasons: runtime.toolStats.skip_reasons,
          steps_total: runtime.stepStats.total,
          stop_reason: runtime.stopReason,
          execution_trace: runtime.executionTrace,
          tokens_used: runtime.totalTokens,
          duration_ms: Date.now() - startTime,
        },
        startTime,
      );
    } catch (error) {
      console.error(`[${this.name}] 执行异常: `, error.message);
      return this.handleError(error);
    }
  }

  async _detectFileChanges(dir, startTime, changeHints = null) {
    if (changeHints && changeHints.modified && changeHints.modified.size > 0) {
      return {
        created: Array.from(changeHints.created || []),
        modified: Array.from(changeHints.modified),
      };
    }

    const changes = { created: [], modified: [] };
    const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.ncf', '.daemon'];

    const scan = async (currentDir) => {
      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && ignoreDirs.includes(entry.name)) continue;
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            await scan(fullPath);
          } else {
            const stat = await fs.stat(fullPath);
            // 允许 1000ms 时间差容错
            if (stat.mtimeMs >= startTime - 1000) {
              const relPath = path.relative(dir, fullPath).replace(/\\/g, '/');
              if (stat.birthtimeMs >= startTime - 1000) {
                changes.created.push(relPath);
              } else {
                changes.modified.push(relPath);
              }
            }
          }
        }
      } catch (e) {
        // 忽略错误
      }
    };

    await scan(dir);
    return changes;
  }

  _formatResult(rawResult, startTime) {
    return {
      task_id: rawResult.task_id || 'unknown',
      agent: this.name,
      status: rawResult.success ? 'success' : 'failed',
      output: {
        files_created: rawResult.files_created || [],
        files_modified: rawResult.files_modified || [],
        tests_run: false,
        summary: rawResult.summary || '',
        tool_calls_executed: rawResult.tool_calls_executed || 0,
        tool_calls_total: rawResult.tool_calls_total || 0,
        tool_calls_success: rawResult.tool_calls_success || 0,
        tool_calls_failed: rawResult.tool_calls_failed || 0,
        tool_calls_skipped: rawResult.tool_calls_skipped || 0,
        skip_reasons: rawResult.skip_reasons || {},
        steps_total: rawResult.steps_total || 0,
        stop_reason: rawResult.stop_reason || STOP_REASON.COMPLETED,
        execution_trace: rawResult.execution_trace || [],
        trace_summary: this._buildTraceSummary(rawResult.execution_trace || []),
      },
      metrics: {
        duration_ms: rawResult.duration_ms || Date.now() - startTime,
        tokens_used: rawResult.tokens_used || 0,
      },
      errors: rawResult.errors || [],
    };
  }

  _buildTraceSummary(executionTrace) {
    const traces = Array.isArray(executionTrace) ? executionTrace : [];
    let toolErrorCount = 0;
    let parallelBatchCount = 0;
    let serialBatchCount = 0;
    let skippedEvents = 0;

    for (const trace of traces) {
      if (trace?.tool_error_code === 'TOOL_SKIPPED') {
        skippedEvents++;
      } else if (trace?.tool_error_code) {
        toolErrorCount++;
      }
      if (trace?.batch_mode === 'parallel') {
        parallelBatchCount++;
      } else if (trace?.batch_mode === 'serial') {
        serialBatchCount++;
      }
    }

    return {
      total_events: traces.length,
      tool_errors: toolErrorCount,
      skipped_events: skippedEvents,
      parallel_events: parallelBatchCount,
      serial_events: serialBatchCount,
    };
  }
}

export default NativeCoderAdapter;
