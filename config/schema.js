/**
 * 极简的配置 Schema 验证
 */

export function validateConfig(config) {
  const errors = [];

  if (config.agents) {
    if (config.agents['native-coder']) {
      if (typeof config.agents['native-coder'].timeout_ms !== 'number') {
        errors.push("agents['native-coder'].timeout_ms must be a number");
      }
    }
    if (config.agents['native-reviewer']) {
      if (typeof config.agents['native-reviewer'].timeout_ms !== 'number') {
        errors.push("agents['native-reviewer'].timeout_ms must be a number");
      }
    }
  }

  if (config.engine) {
    if (typeof config.engine.max_review_cycles !== 'number') {
      errors.push('engine.max_review_cycles must be a number');
    }
    if (config.engine.ab_test) {
      const ab = config.engine.ab_test;
      if (typeof ab.enabled !== 'boolean') {
        errors.push('engine.ab_test.enabled must be a boolean');
      }
      if (typeof ab.mode !== 'string') {
        errors.push('engine.ab_test.mode must be a string');
      }
    }
    if (config.engine.convergence) {
      const c = config.engine.convergence;
      if (typeof c.window_size !== 'number') {
        errors.push('engine.convergence.window_size must be a number');
      }
      if (typeof c.min_score_delta !== 'number') {
        errors.push('engine.convergence.min_score_delta must be a number');
      }
      if (typeof c.max_repeat_issue_rate !== 'number') {
        errors.push('engine.convergence.max_repeat_issue_rate must be a number');
      }
      if (typeof c.max_parse_failures !== 'number') {
        errors.push('engine.convergence.max_parse_failures must be a number');
      }
      if (typeof c.handoff_enabled !== 'boolean') {
        errors.push('engine.convergence.handoff_enabled must be a boolean');
      }
    }
    if (config.engine.feature_flags) {
      const f = config.engine.feature_flags;
      if (typeof f.controller !== 'boolean') {
        errors.push('engine.feature_flags.controller must be a boolean');
      }
      if (typeof f.gate !== 'boolean') {
        errors.push('engine.feature_flags.gate must be a boolean');
      }
      if (typeof f.parser !== 'boolean') {
        errors.push('engine.feature_flags.parser must be a boolean');
      }
      if (typeof f.fingerprint !== 'boolean') {
        errors.push('engine.feature_flags.fingerprint must be a boolean');
      }
    }
    if (config.engine.observability) {
      const ob = config.engine.observability;
      if (typeof ob.structured_json_logs !== 'boolean') {
        errors.push('engine.observability.structured_json_logs must be a boolean');
      }
      if (ob.alerts) {
        if (typeof ob.alerts.long_run_ms !== 'number') {
          errors.push('engine.observability.alerts.long_run_ms must be a number');
        }
        if (typeof ob.alerts.retry_burst !== 'number') {
          errors.push('engine.observability.alerts.retry_burst must be a number');
        }
        if (typeof ob.alerts.parse_failure_storm !== 'number') {
          errors.push('engine.observability.alerts.parse_failure_storm must be a number');
        }
      }
    }
    if (config.engine.release) {
      const rel = config.engine.release;
      if (typeof rel.enabled !== 'boolean') {
        errors.push('engine.release.enabled must be a boolean');
      }
      if (typeof rel.observation_window_days !== 'number') {
        errors.push('engine.release.observation_window_days must be a number');
      }
      if (typeof rel.auto_generate_report !== 'boolean') {
        errors.push('engine.release.auto_generate_report must be a boolean');
      }
    }
  }

  if (config.review) {
    if (typeof config.review.input_gate_enabled !== 'boolean') {
      errors.push('review.input_gate_enabled must be a boolean');
    }
    if (typeof config.review.parser_fallback_enabled !== 'boolean') {
      errors.push('review.parser_fallback_enabled must be a boolean');
    }
    if (typeof config.review.retry_by_error_code !== 'boolean') {
      errors.push('review.retry_by_error_code must be a boolean');
    }
  }

  if (errors.length > 0) {
    throw new Error('Config validation failed:\n' + errors.join('\n'));
  }
}
