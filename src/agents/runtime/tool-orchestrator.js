export const CONCURRENCY_SAFE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'glob_pattern',
  'git_status',
  'git_diff',
]);

export function isConcurrencySafeTool(toolName) {
  return CONCURRENCY_SAFE_TOOLS.has(toolName);
}

export function partitionToolCallsForExecution(preparedCalls) {
  const batches = [];
  for (const call of preparedCalls) {
    const safe = isConcurrencySafeTool(call.tool);
    const prev = batches[batches.length - 1];
    if (prev && prev.isConcurrencySafe && safe) {
      prev.calls.push(call);
    } else {
      batches.push({ isConcurrencySafe: safe, calls: [call] });
    }
  }
  return batches;
}

export async function executeBatchedToolCalls({
  preparedCalls,
  executeSingleCall,
  onCallSettled,
  isStopRequested,
}) {
  const batches = partitionToolCallsForExecution(preparedCalls);
  for (const batch of batches) {
    if (batch.isConcurrencySafe) {
      const settled = await Promise.all(batch.calls.map((call) => executeSingleCall(call)));
      for (let i = 0; i < batch.calls.length; i++) {
        const stop = await onCallSettled(batch.calls[i], settled[i], 'parallel');
        if (stop || (isStopRequested && isStopRequested())) return;
      }
      continue;
    }

    for (const call of batch.calls) {
      const singleRun = await executeSingleCall(call);
      const stop = await onCallSettled(call, singleRun, 'serial');
      if (stop || (isStopRequested && isStopRequested())) return;
    }
  }
}

export async function executeSingleToolCall({
  call,
  step,
  apiRoundTripMs,
  executeTool,
  normalizeResult,
  summarizeArgs,
  onFileSaved,
  onCommandExecuted,
}) {
  const { toolCall, tool, args } = call;
  let toolResultObj;
  const toolStart = Date.now();

  if (tool === 'write_file' || tool === 'edit_file') {
    toolResultObj = await executeTool(tool, args, toolCall.id);
    if (toolResultObj?.success && onFileSaved) {
      onFileSaved(args.file_path);
    }
  } else if (tool === 'bash_execute' || tool === 'npm_run' || tool === 'npm_install') {
    toolResultObj = await executeTool(tool, args, toolCall.id);
    if (onCommandExecuted) {
      onCommandExecuted(tool, toolResultObj?.success === true);
    }
  } else {
    toolResultObj = await executeTool(tool, args, toolCall.id);
  }

  toolResultObj = normalizeResult ? normalizeResult(toolResultObj) : toolResultObj;
  const toolErrorCode = toolResultObj?.needs_confirmation
    ? 'NEEDS_CONFIRMATION'
    : toolResultObj?.success === false
      ? 'TOOL_EXECUTION_FAILED'
      : null;

  return {
    toolResultObj,
    trace: {
      step,
      tool,
      tool_call_id: toolCall.id,
      args_summary: summarizeArgs ? summarizeArgs(args) : JSON.stringify(args || {}),
      success: toolResultObj?.success !== false,
      duration_ms: Date.now() - toolStart,
      api_round_trip_ms: apiRoundTripMs,
      tool_error_code: toolErrorCode,
      error: toolResultObj?.success === false ? toolResultObj?.error || null : null,
    },
    toolErrorsDelta: toolResultObj?.success === false && !toolResultObj?.needs_confirmation ? 1 : 0,
  };
}

export function parseToolCallArgs({
  toolCall,
  step,
  apiRoundTripMs,
  summarizeArgs,
  repairJson,
}) {
  const tool = toolCall.function.name;
  try {
    return { ok: true, args: JSON.parse(toolCall.function.arguments || '{}'), toolErrorsDelta: 0 };
  } catch (_) {
    if (repairJson) {
      try {
        return { ok: true, args: repairJson(toolCall.function.arguments), toolErrorsDelta: 0 };
      } catch (_) {
        // fall through to invalid args report
      }
    }
    return {
      ok: false,
      args: {},
      toolErrorsDelta: 1,
      errorTrace: {
        step,
        tool,
        tool_call_id: toolCall.id,
        args_summary: summarizeArgs ? summarizeArgs({ raw: toolCall.function.arguments }) : '{}',
        success: false,
        duration_ms: 0,
        api_round_trip_ms: apiRoundTripMs,
        tool_error_code: 'INVALID_TOOL_ARGS',
        error: 'Invalid arguments format JSON parse error',
      },
      toolMessage: {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          success: false,
          error: 'Invalid arguments format JSON parse error',
        }),
      },
    };
  }
}

export function prepareToolCalls({
  nativeToolCalls,
  maxToolCallsPerStep,
  maxSameToolCall,
  recordToolCall,
  parseArgs,
  onLimitExceeded,
  onRepeatedCall,
  onInvalidArgs,
}) {
  if (nativeToolCalls.length > maxToolCallsPerStep) {
    if (onLimitExceeded) onLimitExceeded(nativeToolCalls.length);
    return { preparedCalls: [], shouldStop: true };
  }

  const preparedCalls = [];
  for (const toolCall of nativeToolCalls) {
    const tool = toolCall.function.name;
    const parsedArgs = parseArgs(toolCall);
    if (!parsedArgs.ok) {
      if (onInvalidArgs) onInvalidArgs(toolCall, parsedArgs);
      continue;
    }

    const args = parsedArgs.args;
    const repeatedCount = recordToolCall(tool, args);
    if (repeatedCount > maxSameToolCall) {
      if (onRepeatedCall) onRepeatedCall(toolCall, tool, args);
      return { preparedCalls, shouldStop: true };
    }

    preparedCalls.push({ toolCall, tool, args });
  }

  return { preparedCalls, shouldStop: false };
}
