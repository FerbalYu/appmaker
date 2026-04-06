/**
 * Native Reviewer Adapter - AI 代码审查 Agent
 *
 * 集成 UniversalToolbox，支持：
 * - 文件读取工具
 * - Bash 命令执行
 * - LSP 代码诊断
 * - Git 操作
 */

import { AgentAdapter } from './base.js';
import { createExecutionGuard, STOP_REASON, requestStop } from './runtime/guard.js';
import { createTraceRecorder } from './runtime/trace.js';
import { ReviewInputGate } from '../review/review-input-gate.js';
import { ReviewerOutputParser } from '../review/reviewer-output-parser.js';
import { createReviewError, REVIEW_ERROR_CODES } from '../review/error-codes.js';

const NATIVE_REVIEWER_CONFIG = {
  name: 'native-reviewer',
  type: 'api',
  capabilities: ['code-review', 'quality-assurance', 'static-analysis'],
};
const REVIEWER_TOOL_ALLOWLIST = new Set([
  'read_file',
  'list_directory',
  'git_diff',
  'git_status',
  'lsp_diagnostics',
  'search_files',
  'glob_pattern',
]);

export class NativeReviewerAdapter extends AgentAdapter {
  constructor(config = {}) {
    super({ ...NATIVE_REVIEWER_CONFIG, ...config });
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
    this.reviewBudget = {
      maxFiles: config.max_review_files || 12,
      maxFileChars: config.max_review_file_chars || 8000,
      maxTotalChars: config.max_review_total_chars || 40000,
      maxGitDiffChars: config.max_review_git_diff_chars || 2000,
    };
    const reviewConfig = config.review || {};
    const featureFlags = config.feature_flags || {};
    this.reviewConfig = {
      input_gate_enabled: reviewConfig.input_gate_enabled !== false,
      parser_fallback_enabled: reviewConfig.parser_fallback_enabled !== false,
    };
    this.featureFlags = {
      gate: featureFlags.gate !== false,
      parser: featureFlags.parser !== false,
    };
    this.inputGate = new ReviewInputGate();
    this.outputParser = new ReviewerOutputParser({
      extractJSON: (text) => this._extractJSON(text),
    });

    if (config.project_root) {
      this.toolbox.config.workspace_root = config.project_root;
    }
  }

  async healthCheck() {
    return !!this.apiKey;
  }

  /**
   * 获取工具描述供 LLM 使用
   * @private
   */
  _getToolsDescription() {
    const tools = this.getTools().filter((t) => REVIEWER_TOOL_ALLOWLIST.has(t.name));
    const categories = {
      file: tools.filter((t) => t.category === 'file_system').slice(0, 4),
      bash: tools.filter((t) => t.category === 'bash').slice(0, 2),
      git: tools.filter((t) => t.category === 'git'),
      lsp: tools.filter((t) => t.category === 'lsp'),
    };

    let desc = '';

    if (categories.file.length) {
      desc += '\n【文件读取工具】\n';
      categories.file.forEach((t) => {
        if (t.name.includes('read') || t.name.includes('file')) {
          desc += `- ${t.name}: ${t.description}\n`;
        }
      });
    }

    if (categories.lsp.length) {
      desc += '\n【LSP 代码分析工具】\n';
      categories.lsp.forEach((t) => {
        desc += `- ${t.name}: ${t.description}\n`;
      });
    }

    if (categories.git.length) {
      desc += '\n【Git 工具】\n';
      categories.git.forEach((t) => {
        desc += `- ${t.name}: ${t.description}\n`;
      });
    }

    return desc;
  }

  /**
   * 使用工具批量读取文件
   * @private
   */
  async _readFilesForReview(filePaths, projectRoot) {
    const contents = [];
    let totalChars = 0;

    for (const filepath of filePaths) {
      if (contents.length >= this.reviewBudget.maxFiles || totalChars >= this.reviewBudget.maxTotalChars) {
        break;
      }
      const result = await this.executeTool('read_file', { file_path: filepath });
      if (result.success) {
        const remaining = Math.max(this.reviewBudget.maxTotalChars - totalChars, 0);
        const perFileBudget = Math.min(this.reviewBudget.maxFileChars, remaining);
        const rawContent = result.result.content || '';
        const boundedContent =
          perFileBudget > 0 ? rawContent.substring(0, perFileBudget) : '';
        const truncated = rawContent.length > boundedContent.length;
        contents.push({
          path: filepath,
          content: boundedContent,
          size: result.result.size,
          truncated,
        });
        totalChars += boundedContent.length;
      }
    }

    return contents;
  }

  /**
   * 获取 LSP 诊断信息
   * @private
   */
  async _getLspDiagnostics(filePaths) {
    const diagnostics = [];

    for (const filepath of filePaths) {
      const result = await this.executeTool('lsp_diagnostics', {
        file_path: filepath,
        language_server: 'typescript',
      });
      if (result.success && result.result) {
        diagnostics.push({
          file: filepath,
          issues: result.result,
        });
      }
    }

    return diagnostics;
  }

  /**
   * 获取 Git diff 信息
   * @private
   */
  async _getGitDiff(projectRoot) {
    const result = await this.executeTool('git_diff', { cwd: projectRoot });
    return result.success ? result.result.stdout : '';
  }

  async execute(task) {
    const startTime = Date.now();
    const guard = createExecutionGuard();
    const traceRecorder = createTraceRecorder();
    const stop = (reason, stage, note) => {
      requestStop(guard, { reason, stage, note });
    };
    try {
      if (!this.apiKey) {
        throw new Error(
          'API Key missing. Please set OPENAI_API_KEY or MINIMAX_API_KEY for native-reviewer',
        );
      }

      const runtimeFeatureFlags = {
        ...this.featureFlags,
        ...(task.context?.feature_flags || {}),
        ...(task.feature_flags || {}),
      };
      const runtimeReviewConfig = {
        ...this.reviewConfig,
        ...(task.context?.review || {}),
        ...(task.review || {}),
      };

      const projectRoot = task.context?.project_root || '.';
      if (projectRoot) {
        this.toolbox.config.workspace_root = projectRoot;
      }
      const toolsDescription = this._getToolsDescription();

      let codeToReview = '无需审查 (没有任何文件被创建或修改)';
      let filesReviewed = [];
      let filesToRead = [];
      let fileContents = [];

      if (Array.isArray(task.files) && task.files.length > 0) {
        filesToRead = [...task.files];
      } else if (task.context?.code_result) {
        const cr = task.context.code_result.output || task.context.code_result;
        filesToRead = [...(cr.files_created || []), ...(cr.files_modified || [])];
      }

      filesToRead = [...new Set(filesToRead)];
      if (filesToRead.length > this.reviewBudget.maxFiles) {
        filesToRead = filesToRead.slice(0, this.reviewBudget.maxFiles);
      }

      if (filesToRead.length > 0) {
        fileContents = await this._readFilesForReview(filesToRead, projectRoot);
      }

      if (runtimeFeatureFlags.gate && runtimeReviewConfig.input_gate_enabled) {
        const gateResult = this.inputGate.validate({ filesToRead, fileContents });
        if (!gateResult.ok) {
          return this._formatFailedResult({
            task_id: task.id,
            error: gateResult.error,
            error_code: gateResult.error_code || REVIEW_ERROR_CODES.EMPTY_INPUT,
            error_readable: gateResult.error_readable,
            error_category: gateResult.error_category,
            files_reviewed: filesReviewed,
            duration_ms: Date.now() - startTime,
          });
        }
      }

      if (fileContents.length > 0) {
        codeToReview = fileContents
          .map(
            (f) =>
              `--- 文件: ${f.path} (${f.size} bytes${f.truncated ? ', truncated' : ''}) ---\n${f.content}\n`,
          )
          .join('\n');
        filesReviewed = fileContents.map((f) => f.path);

        const lspDiagnostics = await this._getLspDiagnostics(filesToRead);
        if (lspDiagnostics.length > 0) {
          codeToReview += '\n\n--- LSP 诊断信息 ---\n';
          codeToReview += JSON.stringify(lspDiagnostics, null, 2);
        }
      }

      const gitDiff = await this._getGitDiff(projectRoot);
      if (gitDiff) {
        codeToReview += `\n\n--- Git Diff ---\n${gitDiff.substring(0, this.reviewBudget.maxGitDiffChars)}`;
      }

      const systemPrompt = `你是一个非常严厉的资深代码审查员。
你的任务是审查由 AI 刚生成的代码。
请严格挑出代码中的潜在 bug、可维护性问题和不优雅的写法。

## 可用工具
${toolsDescription}

## 评分标准
- 90-100: 代码质量优秀，无需修改
- 70-89: 基本合格，有少量可优化项
- 60-69: 基本可用，需修复一些次要问题
- 50-59: 不可接受，需修复多个重要问题
- <50: 严重问题，必须完全重写

## 输出格式
输出必须是一段合法的纯 JSON 对象，格式如下：
{
  "score": 0到100的分数,
  "summary": "总体评价 (一句话)",
  "issues": [
    {
      "severity": "CRITICAL | WARNING | INFO",
      "title": "问题标题",
      "file": "相关文件路径",
      "line": "相关行号(可选)",
      "reason": "为什么这是问题",
      "suggestion": "具体修改建议"
    }
  ]
}

要求：
- 至少找到 3 个问题（除非代码确实完美）
- CRITICAL 必须包含具体代码行号或位置
- 不要遗漏任何潜在的 bug 或安全问题
- 仔细对照用户提供的"子任务列表"，检查代码是否完成了所有明确要求的子任务。如果漏掉任何一个明确的子任务，请严重扣分（score < 70）并明确指出由于未完成XX任务导致不合格！
- 如果待审查文件或代码内容为空，且该任务明显需要产出（如编写/修改代码或文档），你必须给出极低分（例如 20 分）并判定为 Failed！
- 如果没有问题且确实有实质产出，且全额覆盖了子任务，score 设为 100，issues 设为空数组
不要包含任何 Markdown 标签或额外文字。`;

      const subtasksSection =
        task.subtasks && task.subtasks.length > 0
          ? `\n## 需要验证的子任务列表\n${task.subtasks.map((st, i) => `${i + 1}. ${st}`).join('\n')}\n`
          : '';

      const userPrompt = `## 项目需求
${task.description}
${subtasksSection}
${task.context?.architecture_rules ? `## 架构规范\n${task.context.architecture_rules.substring(0, 800)}\n` : ''}
${task.context?.quality_rules ? `## 质量规范\n${task.context.quality_rules.substring(0, 800)}\n` : ''}

## 待审查文件
${filesReviewed.length > 0 ? filesReviewed.map((f) => `- ${f}`).join('\n') : '无'}

## 代码内容
${codeToReview}

请输出严格的 JSON 审查结果。`;

      const endpoint = this.apiHost.endsWith('/v1')
        ? `${this.apiHost}/chat/completions`
        : `${this.apiHost}/v1/chat/completions`;

      console.log(`[${this.name}] 请求原生 API 进行代码审查... (Model: ${this.model})`);
      console.log(`[${this.name}] 审查文件数: ${filesReviewed.length}`);

      const payload = {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
      };

      if (this.apiHost.includes('minimaxi.com')) {
        payload.extra_body = { reasoning_split: true };
      }

      const externalSignal = task.context?.abortController?.signal || task.context?.abortSignal;
      if (externalSignal?.aborted) {
        stop(STOP_REASON.EXTERNAL_ABORT, 'pre_request', 'external abort signal detected');
        traceRecorder.appendExitTrace(guard);
        return this._formatResult(
          {
            task_id: task.id,
            success: true,
            score: 0,
            summary: '任务在审查前被外部取消。',
            issues: [],
            files_reviewed: filesReviewed,
            stop_reason: STOP_REASON.EXTERNAL_ABORT,
            execution_trace: traceRecorder.traces,
            tokens_used: 0,
            duration_ms: Date.now() - startTime,
          },
          startTime,
        );
      }
      const res = await this._requestCompletion(endpoint, payload, externalSignal);

      if (!res.ok) {
        stop(STOP_REASON.API_ERROR, 'request', `http ${res.status}`);
        throw new Error(`API Error ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();

      if (data.base_resp && data.base_resp.status_code !== 0) {
        throw new Error(
          `MiniMax API Error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`,
        );
      } else if (data.error) {
        throw new Error(`API Error ${data.error.code || data.error.type}: ${data.error.message}`);
      }

      if (!data.choices || data.choices.length === 0) {
        throw new Error(`API 响应结构异常`);
      }

      const message = data.choices[0].message;

      if (message.reasoning_details && message.reasoning_details.length > 0) {
        const reasoningText = message.reasoning_details.map((r) => r.text).join('\n');
        if (typeof this.emit === 'function') {
          this.emit('action', { type: 'think', content: reasoningText.trim() });
        }
      }

      const contentStr = message.content;
      const parseResult =
        runtimeFeatureFlags.parser && runtimeReviewConfig.parser_fallback_enabled
          ? this.outputParser.parse(contentStr)
          : this._parseReviewLegacy(contentStr);
      if (!parseResult.ok) {
        stop(STOP_REASON.API_ERROR, 'parse', parseResult.error);
        return this._formatFailedResult({
          task_id: task.id,
          error: parseResult.error,
          error_code: parseResult.error_code,
          error_readable: parseResult.error_readable,
          error_category: parseResult.error_category,
          files_reviewed: filesReviewed,
          duration_ms: Date.now() - startTime,
          stop_reason: STOP_REASON.API_ERROR,
          execution_trace: traceRecorder.traces,
          tokens_used: data.usage?.total_tokens || 0,
        });
      }
      const resultObj = parseResult.data;

      stop(STOP_REASON.COMPLETED, 'done', 'review completed');
      traceRecorder.appendExitTrace(guard);

      return this._formatResult(
        {
          task_id: task.id,
          success: true,
          score: typeof resultObj.score === 'number' ? resultObj.score : 80,
          summary: resultObj.summary || resultObj.comments || '无评价',
          issues: resultObj.issues || [],
          files_reviewed: filesReviewed,
          stop_reason: STOP_REASON.COMPLETED,
          execution_trace: traceRecorder.traces,
          tokens_used: data.usage?.total_tokens || 0,
          duration_ms: Date.now() - startTime,
        },
        startTime,
      );
    } catch (error) {
      if (guard.stopReason === STOP_REASON.COMPLETED) {
        stop(STOP_REASON.API_ERROR, 'error', error.message);
      }
      traceRecorder.appendExitTrace(guard);
      console.error(`[${this.name}] 执行异常: `, error.message);
      if (error?.error_code) {
        return this._formatFailedResult({
          task_id: task.id,
          error: error.message,
          error_code: error.error_code,
          error_readable: error.error_readable,
          error_category: error.error_category,
          duration_ms: Date.now() - startTime,
          stop_reason: STOP_REASON.API_ERROR,
          execution_trace: traceRecorder.traces,
        });
      }
      return this.handleError(error);
    }
  }

  _formatResult(rawResult, startTime) {
    return {
      task_id: rawResult.task_id || 'unknown',
      agent: this.name,
      status: 'success',
      output: {
        score: rawResult.score,
        summary: rawResult.summary,
        issues: rawResult.issues,
        files_reviewed: rawResult.files_reviewed || [],
        stop_reason: rawResult.stop_reason || STOP_REASON.COMPLETED,
        execution_trace: rawResult.execution_trace || [],
      },
      metrics: {
        duration_ms: rawResult.duration_ms || Date.now() - startTime,
        tokens_used: rawResult.tokens_used || 0,
      },
      errors: [],
    };
  }

  _formatFailedResult(rawResult) {
    return {
      task_id: rawResult.task_id || 'unknown',
      agent: this.name,
      status: 'failed',
      success: false,
      error: rawResult.error || 'review failed',
      error_code: rawResult.error_code || REVIEW_ERROR_CODES.API_ERROR,
      output: {
        score: 0,
        summary: rawResult.error || 'review failed',
        issues: [],
        files_reviewed: rawResult.files_reviewed || [],
        stop_reason: rawResult.stop_reason || STOP_REASON.API_ERROR,
        execution_trace: rawResult.execution_trace || [],
        error_code: rawResult.error_code || REVIEW_ERROR_CODES.API_ERROR,
        error_readable: rawResult.error_readable || '',
        error_category: rawResult.error_category || '',
      },
      metrics: {
        duration_ms: rawResult.duration_ms || 0,
        tokens_used: rawResult.tokens_used || 0,
      },
      errors: [rawResult.error || 'review failed'],
    };
  }

  _parseReviewLegacy(contentStr) {
    const resultObj = this._extractJSON(contentStr);
    if (!resultObj || typeof resultObj.score !== 'number') {
      return createReviewError({
        code: REVIEW_ERROR_CODES.PARSE_FAILED,
        detail: 'legacy 解析路径未获得有效 score',
      });
    }
    return {
      ok: true,
      data: {
        score: resultObj.score,
        summary: resultObj.summary || resultObj.comments || '',
        issues: Array.isArray(resultObj.issues) ? resultObj.issues : [],
      },
    };
  }
}

export default NativeReviewerAdapter;
