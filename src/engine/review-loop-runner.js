import { REVIEW_ERROR_CODES } from '../review/error-codes.js';

export function countCriticalIssues(issues = []) {
  return (issues || []).filter((issue) => String(issue?.severity || '').toUpperCase() === 'CRITICAL')
    .length;
}

export function countGoalDriftCriticalIssues(issues = []) {
  return (issues || []).filter((issue) => {
    const severity = String(issue?.severity || '').toUpperCase();
    if (severity !== 'CRITICAL') return false;
    const text = `${issue?.title || ''} ${issue?.reason || ''} ${issue?.suggestion || ''}`.toLowerCase();
    return (
      text.includes('目标') ||
      text.includes('goal') ||
      text.includes('偏离') ||
      text.includes('drift') ||
      text.includes('偏航')
    );
  }).length;
}

export function extractReviewOutcome(reviewResult) {
  if (!reviewResult) {
    return { ok: false, error: 'Review result missing', error_code: REVIEW_ERROR_CODES.API_ERROR };
  }
  if (reviewResult.status === 'failed' || reviewResult.success === false) {
    return {
      ok: false,
      error:
        reviewResult.error_readable ||
        reviewResult.output?.error_readable ||
        reviewResult.error ||
        reviewResult.output?.summary ||
        'Review failed',
      error_code: reviewResult.error_code || reviewResult.output?.error_code || REVIEW_ERROR_CODES.API_ERROR,
    };
  }
  const score = reviewResult.output?.score;
  if (typeof score !== 'number') {
    return {
      ok: false,
      error: 'Review output missing score',
      error_code: REVIEW_ERROR_CODES.INVALID_SCHEMA,
    };
  }
  return {
    ok: true,
    score,
    issues: reviewResult.output?.issues || [],
    comments: reviewResult.output?.summary || reviewResult.output?.comments || '',
  };
}

export function buildFixTaskQueue(issues = []) {
  const severityWeight = { CRITICAL: 3, WARNING: 2, INFO: 1 };
  return [...(issues || [])]
    .map((issue) => ({
      ...issue,
      _weight: severityWeight[String(issue?.severity || 'INFO').toUpperCase()] || 1,
    }))
    .sort((a, b) => b._weight - a._weight)
    .map(({ _weight, ...rest }) => rest);
}

export function buildFixPrompt(task, codeResult, reviewResult, reviewComments, fixTaskQueue = []) {
  const issues = reviewResult.output?.issues || [];
  let issueList;

  if (issues.length > 0 && typeof issues[0] === 'string') {
    issueList = issues.map((issue, i) => `${i + 1}. [待修复] ${issue}`).join('\n');
  } else {
    issueList = issues
      .map(
        (issue, i) =>
          `${i + 1}. [${issue.severity}] ${issue.title}\n   文件: ${issue.file}\n   问题: ${issue.reason}\n   建议: ${issue.suggestion}`,
      )
      .join('\n');
  }

  if (!issueList) {
    issueList = `评审意见: ${reviewComments || '评分过低 (score < 60)'}`;
  }
  const prioritizedFixes =
    fixTaskQueue.length > 0
      ? `\n差异化补丁任务队列(按优先级执行，避免全文重写):\n${fixTaskQueue
          .slice(0, 8)
          .map(
            (issue, i) =>
              `${i + 1}. [${issue.severity || 'INFO'}] 文件:${issue.file || 'unknown'} | 问题:${issue.title || '未命名问题'} | 建议:${issue.suggestion || '按评审意见修复'}`,
          )
          .join('\n')}\n`
      : '';

  return `修正以下代码中的问题：

任务: ${task.description}

需修正的问题:
${issueList}
${prioritizedFixes}

${reviewComments ? `评审原话: "${reviewComments}"` : ''}

请根据以上问题修改代码，确保：
1. 所有 CRITICAL 问题必须修复
2. 所有 WARNING 问题尽量修复
3. 保持原有功能不变
4. 仅提交必要差异，禁止无关文件重写

修改后确保代码通过质量检查。`;
}

export function buildRollbackRefixPrompt(task, issues = [], reviewComments = '') {
  const issueLines = (issues || [])
    .slice(0, 6)
    .map((issue, i) => `${i + 1}. [${issue.severity || 'INFO'}] ${issue.title || '未命名问题'} (${issue.file || 'unknown'})`)
    .join('\n');
  return `你上一次修复收益不足，系统已回滚相关文件。请进行更小粒度的二次修复：

任务: ${task.description}

二次修复清单:
${issueLines || '- 按评审意见进行小范围补丁修复'}

要求：
1. 仅修改必要行，避免大段重写
2. 优先解决重复出现的问题
3. 保持接口与行为兼容`;
}

export function shouldRollbackAndRefix({ previousScore, newScore, repeatRate, fileChangeEffective }) {
  return (
    Number.isFinite(previousScore) &&
    Number.isFinite(newScore) &&
    newScore <= previousScore &&
    repeatRate >= 0.8 &&
    fileChangeEffective === false
  );
}

export function buildHumanHandoffResult(task, payload) {
  return {
    task_id: task.id,
    status: 'needs_human',
    phase: 'handoff',
    stop_reason: payload.stopReason,
    cycles: payload.cycle || 0,
    score: payload.reviewScore || 0,
    issues: payload.reviewIssues || [],
    comments: payload.reviewComments || '',
    code_result: payload.codeResult,
    quality_metrics: payload.qualityMetrics || {},
    handoff: {
      stop_reason: payload.stopReason,
      evidence: payload.evidence || {},
      last_suggestion: payload.reviewComments || '',
      actions: ['人工检查关键问题', '确认是否继续自动修复', '必要时调整阈值后重试'],
    },
  };
}

export function buildForcedGoalReplanPrompt(task, reviewIssues = [], reviewComments = '', goalInvariantSummary = '') {
  const issueLines = (reviewIssues || [])
    .slice(0, 6)
    .map(
      (issue, idx) =>
        `${idx + 1}. [${issue.severity || 'UNKNOWN'}] ${issue.title || 'unknown'} - ${
          issue.reason || issue.suggestion || 'no detail'
        }`,
    )
    .join('\n');
  const goalInvariant = goalInvariantSummary || task.goal || '保持原始业务目标不变';
  return `[FORCED_GOAL_REPLAN]
计划可变，目的不可变。你必须先对齐目标，再调整实现路径。

目标不变约束:
${goalInvariant}

当前偏离问题:
${issueLines || reviewComments || '目标偏航'}

要求：
1. 重新对齐目标不变约束
2. 调整实现路径以符合目标
3. 保持代码质量`;
}

export function hasEffectiveFileChange(previousCodeResult, nextCodeResult) {
  const before = new Set([
    ...(previousCodeResult?.output?.files_created || []),
    ...(previousCodeResult?.output?.files_modified || []),
  ]);
  const after = new Set([
    ...(nextCodeResult?.output?.files_created || []),
    ...(nextCodeResult?.output?.files_modified || []),
  ]);
  if (after.size === 0) {
    return false;
  }
  for (const item of after) {
    if (!before.has(item)) {
      return true;
    }
  }

  const beforeHashes = previousCodeResult?.output?.file_hashes || {};
  const afterHashes = nextCodeResult?.output?.file_hashes || {};
  let comparableCount = 0;

  for (const item of after) {
    if (!before.has(item)) continue;
    const beforeHash = beforeHashes[item];
    const afterHash = afterHashes[item];
    if (typeof beforeHash === 'string' && typeof afterHash === 'string') {
      comparableCount += 1;
      if (beforeHash !== afterHash) {
        return true;
      }
    }
  }

  if (comparableCount > 0) {
    return false;
  }
  return false;
}
