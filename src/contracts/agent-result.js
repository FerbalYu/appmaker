function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function stringOrDefault(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function numberOrDefault(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeError(error, fallback = 'Unknown error') {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === 'object') {
    return error.message || error.error || JSON.stringify(error);
  }
  return String(error);
}

function normalizeMetrics(metrics) {
  const source = objectOrEmpty(metrics);
  return {
    duration_ms: numberOrDefault(source.duration_ms, 0),
    tokens_used: numberOrDefault(source.tokens_used, 0),
  };
}

function isFailedResult(result) {
  return !result || result.status === 'failed' || result.success === false;
}

export function normalizeCoderResult(result = {}) {
  const source = objectOrEmpty(result);
  const output = objectOrEmpty(source.output);
  const failed = isFailedResult(source);
  const errors = arrayOrEmpty(source.errors);
  const error = failed ? normalizeError(source.error || errors[0], 'Code agent failed') : '';

  return {
    task_id: stringOrDefault(source.task_id, 'unknown'),
    agent: stringOrDefault(source.agent, 'native-coder'),
    status: failed ? 'failed' : 'success',
    success: !failed,
    error,
    output: {
      files_created: arrayOrEmpty(output.files_created),
      files_modified: arrayOrEmpty(output.files_modified),
      tests_run: output.tests_run === true,
      summary: stringOrDefault(output.summary),
      tool_calls_executed: numberOrDefault(output.tool_calls_executed, 0),
      tool_calls_total: numberOrDefault(output.tool_calls_total, 0),
      tool_calls_success: numberOrDefault(output.tool_calls_success, 0),
      tool_calls_failed: numberOrDefault(output.tool_calls_failed, 0),
      tool_calls_skipped: numberOrDefault(output.tool_calls_skipped, 0),
      skip_reasons: objectOrEmpty(output.skip_reasons),
      steps_total: numberOrDefault(output.steps_total, 0),
      stop_reason: stringOrDefault(output.stop_reason),
      execution_trace: arrayOrEmpty(output.execution_trace),
      trace_summary: objectOrEmpty(output.trace_summary),
    },
    metrics: normalizeMetrics(source.metrics),
    errors: failed && errors.length === 0 ? [error] : errors,
  };
}

export function normalizeReviewerResult(result = {}) {
  const source = objectOrEmpty(result);
  const output = objectOrEmpty(source.output);
  const failed = isFailedResult(source);
  const errors = arrayOrEmpty(source.errors);
  const error = failed ? normalizeError(source.error || output.error_readable || errors[0], 'Review agent failed') : '';
  const errorCode = source.error_code || output.error_code || '';

  return {
    task_id: stringOrDefault(source.task_id, 'unknown'),
    agent: stringOrDefault(source.agent, 'native-reviewer'),
    status: failed ? 'failed' : 'success',
    success: !failed,
    error,
    error_code: stringOrDefault(errorCode),
    output: {
      score: numberOrDefault(output.score, 0),
      summary: stringOrDefault(output.summary || output.comments || error),
      issues: arrayOrEmpty(output.issues),
      files_reviewed: arrayOrEmpty(output.files_reviewed),
      stop_reason: stringOrDefault(output.stop_reason),
      execution_trace: arrayOrEmpty(output.execution_trace),
      error_code: stringOrDefault(errorCode),
      error_readable: stringOrDefault(output.error_readable || error),
      error_category: stringOrDefault(output.error_category),
    },
    metrics: normalizeMetrics(source.metrics),
    errors: failed && errors.length === 0 ? [error] : errors,
  };
}
