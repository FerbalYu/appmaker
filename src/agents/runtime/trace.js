export function createTraceRecorder() {
  const traces = [];

  function push(trace) {
    traces.push({
      exit_stage: trace.exit_stage || null,
      exit_note: trace.exit_note || null,
      guard_generation: trace.guard_generation || null,
      ...trace,
    });
  }

  function appendExitTrace(guard) {
    push({
      step: -1,
      tool: '__exit__',
      tool_call_id: null,
      args_summary: '{}',
      success: guard.stopReason === 'completed',
      duration_ms: 0,
      api_round_trip_ms: 0,
      tool_error_code: null,
      error: null,
      exit_stage: guard.exitStage,
      exit_note: guard.exitNote,
      guard_generation: guard.generation,
    });
  }

  return {
    traces,
    push,
    appendExitTrace,
  };
}
