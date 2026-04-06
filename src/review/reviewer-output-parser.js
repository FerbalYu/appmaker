import { createReviewError, REVIEW_ERROR_CODES } from './error-codes.js';

function normalizeIssue(issue = {}) {
  return {
    severity: issue.severity || 'INFO',
    title: issue.title || '未命名问题',
    file: issue.file || 'unknown',
    line: issue.line || null,
    reason: issue.reason || '',
    suggestion: issue.suggestion || '',
  };
}

export class ReviewerOutputParser {
  constructor({ extractJSON } = {}) {
    this.extractJSON = extractJSON || ((text) => JSON.parse(text));
  }

  parse(rawContent) {
    let parsed;
    try {
      parsed = this.extractJSON(rawContent);
    } catch {
      parsed = null;
    }

    if (!parsed || typeof parsed !== 'object') {
      return createReviewError({
        code: REVIEW_ERROR_CODES.PARSE_FAILED,
        detail: '模型输出无法解析为对象',
      });
    }

    if (typeof parsed.score !== 'number') {
      return createReviewError({
        code: REVIEW_ERROR_CODES.INVALID_SCHEMA,
        detail: '缺少 score 或 score 不是 number',
      });
    }

    if (parsed.issues && !Array.isArray(parsed.issues)) {
      return createReviewError({
        code: REVIEW_ERROR_CODES.INVALID_SCHEMA,
        detail: 'issues 字段必须是数组',
      });
    }

    return {
      ok: true,
      data: {
        score: parsed.score,
        summary: parsed.summary || parsed.comments || '',
        issues: Array.isArray(parsed.issues) ? parsed.issues.map(normalizeIssue) : [],
      },
    };
  }
}

export default ReviewerOutputParser;
