export function createStopHookRunner(hooks = []) {
  const normalizedHooks = Array.isArray(hooks) ? hooks.filter((h) => typeof h === 'function') : [];

  return async function runStopHooks(context) {
    for (const hook of normalizedHooks) {
      const result = await hook(context);
      if (!result) continue;
      if (result.stop) {
        return {
          stop: true,
          reason: result.reason || null,
          content: result.content || null,
          note: result.note || '',
          stage: result.stage || 'hook',
          trace: result.trace || null,
        };
      }
    }
    return { stop: false };
  };
}

export function createDefaultStopHooks(config = {}) {
  const maxConsecutiveFailures = Number.isFinite(config.max_consecutive_failures)
    ? Math.max(1, config.max_consecutive_failures)
    : 10;
  const maxSkippedCalls = Number.isFinite(config.max_skipped_calls)
    ? Math.max(1, config.max_skipped_calls)
    : 20;

  return [
    ({ runtime }) => {
      if ((runtime?.consecutiveToolFailures || 0) >= maxConsecutiveFailures) {
        return {
          stop: true,
          reason: 'hook_consecutive_failures',
          content: `连续工具失败达到阈值(${maxConsecutiveFailures})，已通过 stop hook 停止。`,
          note: `consecutiveToolFailures=${runtime.consecutiveToolFailures}`,
          stage: 'hook_post_tool_result',
        };
      }
      return null;
    },
    ({ runtime }) => {
      const skipped = runtime?.toolStats?.skipped || 0;
      if (skipped >= maxSkippedCalls) {
        return {
          stop: true,
          reason: 'hook_skipped_calls_limit',
          content: `跳过的工具调用达到阈值(${maxSkippedCalls})，已通过 stop hook 停止。`,
          note: `skipped=${skipped}`,
          stage: 'hook_post_tool_dispatch',
        };
      }
      return null;
    },
  ];
}
