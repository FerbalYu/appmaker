export const LOOP_STATE = {
  IDLE: 'idle',
  DISPATCHING: 'dispatching',
  RUNNING: 'running',
  STOPPING: 'stopping',
  FINISHED: 'finished',
};

export const STOP_REASON = {
  COMPLETED: 'completed',
  NO_TOOL_CALLS: 'no_tool_calls',
  REPEATED_TOOL_CALL: 'repeated_tool_call',
  TOOL_CALLS_LIMIT: 'tool_calls_limit',
  TOOL_ERRORS_LIMIT: 'tool_errors_limit',
  EXTERNAL_ABORT: 'external_abort',
  API_ERROR: 'api_error',
  MAX_STEPS_REACHED: 'max_steps_reached',
};

export function createExecutionGuard() {
  return {
    generation: 1,
    state: LOOP_STATE.RUNNING,
    stopReason: STOP_REASON.COMPLETED,
    exitStage: 'init',
    exitNote: 'started',
  };
}

export function isTerminalStopReason(reason) {
  return new Set(Object.values(STOP_REASON)).has(reason);
}

export function requestStop(guard, { reason, stage = 'loop', note = '', expectedGeneration = null }) {
  if (
    expectedGeneration !== null &&
    expectedGeneration !== undefined &&
    expectedGeneration !== guard.generation
  ) {
    return false;
  }
  guard.state = LOOP_STATE.STOPPING;
  guard.stopReason = reason;
  guard.exitStage = stage;
  guard.exitNote = note || reason;
  guard.generation += 1;
  return true;
}
