const DEFAULTS = {
  window_size: 3,
  min_score_delta: 3,
  max_repeat_issue_rate: 0.7,
  max_parse_failures: 2,
  diminishing_streak_required: 2,
  soft_stop_enabled: true,
  handoff_enabled: true,
};

export class ReviewConvergenceController {
  constructor(config = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.parseFailures = 0;
    this.softStopIssued = false;
  }

  evaluate(ledger) {
    const recent = ledger.getRecent(this.config.window_size);
    const latest = recent[recent.length - 1];
    if (!latest) {
      return { action: 'continue' };
    }

    if (latest.parse_failed) {
      this.parseFailures += 1;
      if (this.parseFailures >= this.config.max_parse_failures) {
        return {
          action: 'handoff',
          stop_reason: 'PARSE_FAILURE_STORM',
          evidence: { parse_failures: this.parseFailures },
        };
      }
      return { action: 'continue' };
    }

    this.parseFailures = 0;
    if (recent.length < 2) {
      return { action: 'continue' };
    }

    const diminishingSignalCount = this._countRecentDiminishingSignals(recent);
    const prev = recent[recent.length - 2];
    const scoreDelta = (latest.score || 0) - (prev.score || 0);
    const criticalDelta = (prev.critical_count || 0) - (latest.critical_count || 0);
    const diminishing = diminishingSignalCount >= this.config.diminishing_streak_required;

    if (diminishing) {
      if (this.config.soft_stop_enabled && !this.softStopIssued) {
        this.softStopIssued = true;
        return {
          action: 'soft_stop',
          stop_reason: 'DIMINISHING_RETURNS_SOFT_STOP',
          evidence: {
            diminishing_signal_count: diminishingSignalCount,
            diminishing_streak_required: this.config.diminishing_streak_required,
            score_delta: scoreDelta,
            critical_delta: criticalDelta,
            issue_repeat_rate: latest.issue_repeat_rate || 0,
            file_change_effective: latest.file_change_effective,
          },
        };
      }
      return {
        action: this.config.handoff_enabled ? 'handoff' : 'stop',
        stop_reason: 'DIMINISHING_RETURNS',
        evidence: {
          diminishing_signal_count: diminishingSignalCount,
          diminishing_streak_required: this.config.diminishing_streak_required,
          score_delta: scoreDelta,
          critical_delta: criticalDelta,
          issue_repeat_rate: latest.issue_repeat_rate || 0,
          file_change_effective: latest.file_change_effective,
        },
      };
    }

    this.softStopIssued = false;
    return { action: 'continue' };
  }

  _countRecentDiminishingSignals(rounds = []) {
    let count = 0;
    for (let i = rounds.length - 1; i > 0; i -= 1) {
      const current = rounds[i] || {};
      const previous = rounds[i - 1] || {};
      const scoreDelta = (current.score || 0) - (previous.score || 0);
      const criticalDelta = (previous.critical_count || 0) - (current.critical_count || 0);
      const isDiminishingSignal =
        scoreDelta < this.config.min_score_delta &&
        criticalDelta <= 0 &&
        (current.issue_repeat_rate || 0) >= this.config.max_repeat_issue_rate &&
        current.file_change_effective === false;

      if (!isDiminishingSignal) {
        break;
      }
      count += 1;
    }
    return count;
  }
}

export default ReviewConvergenceController;
