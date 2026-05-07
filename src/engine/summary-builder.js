export function buildSummary({
  results,
  startTime,
  tokenUsage = { total: 0 },
  abStats = { enabled: false, mode: 'shadow', total_compares: 0, divergence_count: 0, samples: [] },
  alerts = [],
  featureFlagAudit = [],
  recoveryStats = { attempts: 0, recovered_tasks: 0, replanned_tasks: 0, decisions: [] },
  probeStats = {
    preflight_checks: 0,
    already_satisfied_skips: 0,
    missing_artifact_hits: 0,
    probe_replan_tasks: 0,
    probe_replan_completed: 0,
    probe_replan_failed: 0,
  },
} = {}) {
  const done = results.filter((r) => r.status === 'done').length;
  const failedRaw = results.filter((r) => r.status === 'failed').length;
  const blocked = results.filter((r) => r.status === 'blocked').length;
  const deadlock = results.filter((r) => r.status === 'deadlock').length;
  const failed = failedRaw + blocked + deadlock;
  const needsHuman = results.filter((r) => r.status === 'needs_human').length;
  const totalCycles = results.reduce((sum, r) => sum + (r.cycles || 0), 0);
  const avgScore = results.reduce((sum, r) => sum + (r.score || 0), 0) / (results.length || 1);
  const diminishingAbort = results.filter((r) => r.stop_reason === 'DIMINISHING_RETURNS').length;
  const successBase = done || 1;
  const total = results.length || 1;

  const summary = {
    total: results.length,
    done,
    failed,
    blocked,
    deadlock,
    needs_human: needsHuman,
    total_review_cycles: totalCycles,
    average_score: Math.round(avgScore),
    convergence_rate: done / total,
    avg_cycles: totalCycles / total,
    diminishing_abort_rate: diminishingAbort / total,
    tokens_per_success_task: tokenUsage.total / successBase,
    wasted_token_ratio: (failed + needsHuman) / total,
    duration_ms: Date.now() - startTime,
  };

  if (abStats.enabled) {
    summary.ab_test = {
      mode: abStats.mode,
      total_compares: abStats.total_compares,
      divergence_count: abStats.divergence_count,
      divergence_rate:
        abStats.total_compares > 0
          ? abStats.divergence_count / abStats.total_compares
          : 0,
      samples: abStats.samples,
    };
  }

  const repeatRates = results
    .map((r) => r.quality_metrics?.repeat_issue_rate)
    .filter((v) => typeof v === 'number');
  const clearanceTimes = results
    .map((r) => r.quality_metrics?.critical_clearance_time)
    .filter((v) => typeof v === 'number');
  summary.repeat_issue_rate =
    repeatRates.length > 0 ? repeatRates.reduce((a, b) => a + b, 0) / repeatRates.length : 0;
  summary.critical_clearance_time =
    clearanceTimes.length > 0
      ? clearanceTimes.reduce((a, b) => a + b, 0) / clearanceTimes.length
      : null;

  if (alerts.length > 0) {
    summary.alert_count = alerts.length;
    summary.alert_tail = alerts.slice(-10);
    summary.alert_by_rule = alerts.reduce((acc, alert) => {
      acc[alert.rule] = (acc[alert.rule] || 0) + 1;
      return acc;
    }, {});
    summary.alert_by_category = alerts.reduce((acc, alert) => {
      const category = alert.details?.error_category || 'general';
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {});
  }

  if (featureFlagAudit.length > 0) {
    summary.feature_flag_audit_count = featureFlagAudit.length;
    summary.feature_flag_audit_tail = featureFlagAudit.slice(-5);
  }

  summary.recovery = {
    attempts: recoveryStats.attempts,
    recovered_tasks: recoveryStats.recovered_tasks,
    replanned_tasks: recoveryStats.replanned_tasks,
    decisions_tail: recoveryStats.decisions.slice(-10),
  };

  summary.state_probe = {
    preflight_checks: probeStats.preflight_checks,
    already_satisfied_skips: probeStats.already_satisfied_skips,
    missing_artifact_hits: probeStats.missing_artifact_hits,
    probe_replan_tasks: probeStats.probe_replan_tasks,
    probe_replan_completed: probeStats.probe_replan_completed,
    probe_replan_failed: probeStats.probe_replan_failed,
  };

  return summary;
}
