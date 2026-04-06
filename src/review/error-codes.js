export const REVIEW_ERROR_CODES = {
  PARSE_FAILED: 'PARSE_FAILED',
  EMPTY_INPUT: 'EMPTY_INPUT',
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
  API_ERROR: 'API_ERROR',
};

export function isRetryableReviewErrorCode(code) {
  return code === REVIEW_ERROR_CODES.API_ERROR || code === REVIEW_ERROR_CODES.PARSE_FAILED;
}

export const REVIEW_ERROR_MESSAGES = {
  [REVIEW_ERROR_CODES.PARSE_FAILED]: '评审输出解析失败，请检查模型输出是否为合法 JSON。',
  [REVIEW_ERROR_CODES.EMPTY_INPUT]: '评审输入为空，未进入有效评审流程。',
  [REVIEW_ERROR_CODES.INVALID_SCHEMA]: '评审输出结构不合法，缺少必填字段或类型错误。',
  [REVIEW_ERROR_CODES.TOOL_EXECUTION_FAILED]: '评审依赖的工具执行失败，无法获取有效审查输入。',
  [REVIEW_ERROR_CODES.API_ERROR]: '评审 API 调用失败，请检查服务状态与网络连通性。',
};

export const REVIEW_ERROR_CATEGORIES = {
  [REVIEW_ERROR_CODES.PARSE_FAILED]: 'parse',
  [REVIEW_ERROR_CODES.EMPTY_INPUT]: 'input',
  [REVIEW_ERROR_CODES.INVALID_SCHEMA]: 'schema',
  [REVIEW_ERROR_CODES.TOOL_EXECUTION_FAILED]: 'tool',
  [REVIEW_ERROR_CODES.API_ERROR]: 'api',
};

export function getReviewErrorMessage(code, detail = '') {
  const base = REVIEW_ERROR_MESSAGES[code] || REVIEW_ERROR_MESSAGES[REVIEW_ERROR_CODES.API_ERROR];
  if (!detail) {
    return base;
  }
  return `${base} 详情: ${detail}`;
}

export function createReviewError({ code, detail = '', fallbackCode = REVIEW_ERROR_CODES.API_ERROR } = {}) {
  const errorCode = code || fallbackCode;
  return {
    ok: false,
    error_code: errorCode,
    error: getReviewErrorMessage(errorCode, detail),
    error_readable: REVIEW_ERROR_MESSAGES[errorCode] || REVIEW_ERROR_MESSAGES[fallbackCode],
    error_category: REVIEW_ERROR_CATEGORIES[errorCode] || REVIEW_ERROR_CATEGORIES[fallbackCode],
  };
}
