/**
 * 极简的配置 Schema 验证
 */

export function validateConfig(config) {
  const errors = [];

  if (config.agents) {
    if (config.agents['claude-code']) {
      if (typeof config.agents['claude-code'].timeout_ms !== 'number') {
        errors.push("agents['claude-code'].timeout_ms must be a number");
      }
    }
    if (config.agents.opencode) {
      if (typeof config.agents.opencode.timeout_ms !== 'number') {
        errors.push("agents.opencode.timeout_ms must be a number");
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
