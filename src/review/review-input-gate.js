import { createReviewError, REVIEW_ERROR_CODES } from './error-codes.js';

function isMeaningfulContent(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !['{}', '[]', 'null', 'undefined', 'todo', 'placeholder'].includes(trimmed.toLowerCase());
}

export class ReviewInputGate {
  validate({ filesToRead = [], fileContents = [] } = {}) {
    if (!Array.isArray(filesToRead) || filesToRead.length === 0) {
      return createReviewError({
        code: REVIEW_ERROR_CODES.EMPTY_INPUT,
        detail: '待审查文件为空',
      });
    }

    const readableCount = (fileContents || []).length;
    if (readableCount === 0) {
      return createReviewError({
        code: REVIEW_ERROR_CODES.TOOL_EXECUTION_FAILED,
        detail: '文件读取全部失败',
      });
    }

    const hasMeaningfulContent = fileContents.some((file) => isMeaningfulContent(file.content));
    if (!hasMeaningfulContent) {
      return createReviewError({
        code: REVIEW_ERROR_CODES.EMPTY_INPUT,
        detail: '代码内容为空或仅占位符',
      });
    }

    return { ok: true };
  }
}

export default ReviewInputGate;
