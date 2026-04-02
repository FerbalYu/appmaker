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
  }

  if (errors.length > 0) {
    throw new Error('Config validation failed:\n' + errors.join('\n'));
  }
}
