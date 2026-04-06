export const CONCURRENCY_SAFE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'glob_pattern',
  'git_status',
  'git_diff',
]);

export const TOOL_SKIP_REASONS = {
  INVALID_ARGS: 'invalid_args',
  TOOL_CALLS_LIMIT: 'tool_calls_limit',
  REPEATED_CALL: 'repeated_call',
  STOP_REQUESTED: 'stop_requested',
  CASCADE_CANCELLED: 'cascade_cancelled',
};

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
  onCallSkipped,
  shouldCascadeCancel,
}) {
  let cascadeCancelled = false;
  const batches = partitionToolCallsForExecution(preparedCalls);
  for (const batch of batches) {
    if (cascadeCancelled) {
      for (const call of batch.calls) {
        if (onCallSkipped) {
          await onCallSkipped(call, TOOL_SKIP_REASONS.CASCADE_CANCELLED, {
            error: 'Skipped because a previous tool call triggered cascade cancellation',
          });
        }
      }
      continue;
    }

    if (isStopRequested && isStopRequested()) {
      for (const call of batch.calls) {
        if (onCallSkipped) {
          await onCallSkipped(call, TOOL_SKIP_REASONS.STOP_REQUESTED, {
            error: 'Skipped because stop was already requested',
          });
        }
      }
      return;
    }

    if (batch.isConcurrencySafe) {
      const settled = await Promise.all(
        batch.calls.map(async (call) => {
          if (isStopRequested && isStopRequested()) {
            return {
              skipped: true,
              skipReason: TOOL_SKIP_REASONS.STOP_REQUESTED,
              toolResultObj: {
                success: false,
                error: 'Skipped because stop was requested while dispatching concurrent tools',
              },
            };
          }
          return executeSingleCall(call);
        }),
      );
      for (let i = 0; i < batch.calls.length; i++) {
        const call = batch.calls[i];
        const singleRun = settled[i];
        if (singleRun?.skipped) {
          if (onCallSkipped) {
            await onCallSkipped(call, singleRun.skipReason || TOOL_SKIP_REASONS.STOP_REQUESTED, {
              error: singleRun?.toolResultObj?.error || 'Skipped',
            });
          }
          continue;
        }

        const stop = await onCallSettled(call, singleRun, 'parallel');
        if (shouldCascadeCancel && shouldCascadeCancel(call, singleRun, 'parallel')) {
          cascadeCancelled = true;
        }
        if (stop || (isStopRequested && isStopRequested())) return;
      }
      continue;
    }

    for (const call of batch.calls) {
      if (cascadeCancelled) {
        if (onCallSkipped) {
          await onCallSkipped(call, TOOL_SKIP_REASONS.CASCADE_CANCELLED, {
            error: 'Skipped because a previous tool call triggered cascade cancellation',
          });
        }
        continue;
      }
      if (isStopRequested && isStopRequested()) {
        if (onCallSkipped) {
          await onCallSkipped(call, TOOL_SKIP_REASONS.STOP_REQUESTED, {
            error: 'Skipped because stop was requested',
          });
        }
        return;
      }
      const singleRun = await executeSingleCall(call);
      if (singleRun?.skipped) {
        if (onCallSkipped) {
          await onCallSkipped(
            call,
            singleRun.skipReason || TOOL_SKIP_REASONS.STOP_REQUESTED,
            singleRun.toolResultObj,
          );
        }
        continue;
      }
      const stop = await onCallSettled(call, singleRun, 'serial');
      if (shouldCascadeCancel && shouldCascadeCancel(call, singleRun, 'serial')) {
        cascadeCancelled = true;
      }
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
    return {
      preparedCalls: [],
      shouldStop: true,
      skipped: nativeToolCalls.length,
      skipReasons: { [TOOL_SKIP_REASONS.TOOL_CALLS_LIMIT]: nativeToolCalls.length },
    };
  }

  const preparedCalls = [];
  const skipReasons = {};
  let skipped = 0;
  for (const toolCall of nativeToolCalls) {
    const tool = toolCall.function.name;
    const parsedArgs = parseArgs(toolCall);
    if (!parsedArgs.ok) {
      if (onInvalidArgs) onInvalidArgs(toolCall, parsedArgs);
      skipped += 1;
      skipReasons[TOOL_SKIP_REASONS.INVALID_ARGS] =
        (skipReasons[TOOL_SKIP_REASONS.INVALID_ARGS] || 0) + 1;
      continue;
    }

    const args = parsedArgs.args;
    const repeatedCount = recordToolCall(tool, args);
    if (repeatedCount > maxSameToolCall) {
      if (onRepeatedCall) onRepeatedCall(toolCall, tool, args);
      skipped += 1;
      skipReasons[TOOL_SKIP_REASONS.REPEATED_CALL] =
        (skipReasons[TOOL_SKIP_REASONS.REPEATED_CALL] || 0) + 1;
      return { preparedCalls, shouldStop: true, skipped, skipReasons };
    }

    preparedCalls.push({ toolCall, tool, args });
  }

  return { preparedCalls, shouldStop: false, skipped, skipReasons };
}
