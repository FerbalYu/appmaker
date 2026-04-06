import { isRetryableReviewErrorCode, REVIEW_ERROR_CODES } from '../review/error-codes.js';

export class ExecutionPolicyEngine {
  getRetryDecision({ phase, error, errorCode } = {}) {
    const normalizedPhase = String(phase || '').toLowerCase();
    const message = String(error?.message || error || '').toLowerCase();
    const statusCode = this._extractStatusCode(error, message);
    const retryAfterMs = this._extractRetryAfterMs(error);

    if (
      errorCode === REVIEW_ERROR_CODES.EMPTY_INPUT ||
      errorCode === REVIEW_ERROR_CODES.INVALID_SCHEMA
    ) {
      return this._decision(false, 'review_non_retryable_error_code', {
        error_code: errorCode,
        status_code: statusCode,
      });
    }

    if (normalizedPhase.includes('review') && errorCode) {
      return this._decision(isRetryableReviewErrorCode(errorCode), 'review_error_code', {
        error_code: errorCode,
        status_code: statusCode,
      });
    }

    if (statusCode === 429 || statusCode === 529) {
      return this._decision(true, 'capacity_or_rate_limit', {
        error_code: errorCode || null,
        status_code: statusCode,
        suggested_delay_ms: retryAfterMs ?? 120000,
      });
    }

    if (statusCode === 408 || statusCode === 409) {
      return this._decision(true, 'transient_timeout_or_conflict', {
        error_code: errorCode || null,
        status_code: statusCode,
      });
    }

    if (statusCode && statusCode >= 500) {
      return this._decision(true, 'server_error_retryable', {
        error_code: errorCode || null,
        status_code: statusCode,
      });
    }

    const retryablePatterns = [
      'timeout',
      'timed out',
      'econnreset',
      'etimedout',
      'econnrefused',
      'network',
      'socket hang up',
      'fetch',
      'api error',
      'overloaded_error',
      'rate limit',
      'parse error',
      'json',
    ];
    if (retryablePatterns.some((pattern) => message.includes(pattern))) {
      return this._decision(true, 'message_pattern_retryable', {
        error_code: errorCode || null,
        status_code: statusCode,
      });
    }

    return this._decision(false, 'non_retryable', {
      error_code: errorCode || null,
      status_code: statusCode,
    });
  }

  shouldRetry({ phase, error, errorCode }) {
    return this.getRetryDecision({ phase, error, errorCode }).should_retry;
  }

  _decision(shouldRetry, reason, extra = {}) {
    return {
      should_retry: shouldRetry,
      reason,
      ...extra,
    };
  }

  _extractStatusCode(error, message = '') {
    const direct = Number(error?.status);
    if (Number.isFinite(direct) && direct > 0) {
      return direct;
    }

    const matched = message.match(/\b(408|409|429|500|502|503|504|529)\b/);
    if (matched) {
      return Number(matched[1]);
    }
    return null;
  }

  _extractRetryAfterMs(error) {
    const headers = error?.headers;
    let retryAfterValue = null;

    if (headers && typeof headers.get === 'function') {
      retryAfterValue = headers.get('retry-after');
    } else if (headers && typeof headers === 'object') {
      retryAfterValue = headers['retry-after'] || headers['Retry-After'];
    }

    if (retryAfterValue == null) {
      return null;
    }

    const seconds = Number.parseInt(String(retryAfterValue), 10);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    return seconds * 1000;
  }
}

export default ExecutionPolicyEngine;
