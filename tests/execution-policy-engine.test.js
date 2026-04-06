import { ExecutionPolicyEngine } from '../src/convergence/execution-policy-engine.js';

describe('ExecutionPolicyEngine', () => {
  it('should not retry EMPTY_INPUT review errors', () => {
    const engine = new ExecutionPolicyEngine();
    const decision = engine.getRetryDecision({
      phase: 'review',
      errorCode: 'EMPTY_INPUT',
      error: new Error('empty review input'),
    });

    expect(decision.should_retry).toBe(false);
    expect(decision.reason).toBe('review_non_retryable_error_code');
  });

  it('should retry PARSE_FAILED in review phase', () => {
    const engine = new ExecutionPolicyEngine();
    const decision = engine.getRetryDecision({
      phase: 'review',
      errorCode: 'PARSE_FAILED',
      error: new Error('parse failed'),
    });

    expect(decision.should_retry).toBe(true);
    expect(decision.reason).toBe('review_error_code');
  });

  it('should honor retry-after header for rate limits', () => {
    const engine = new ExecutionPolicyEngine();
    const decision = engine.getRetryDecision({
      phase: 'review',
      error: {
        status: 429,
        headers: {
          get: (name) => (name === 'retry-after' ? '7' : null),
        },
      },
    });

    expect(decision.should_retry).toBe(true);
    expect(decision.reason).toBe('capacity_or_rate_limit');
    expect(decision.suggested_delay_ms).toBe(7000);
  });

  it('should classify transient network messages as retryable', () => {
    const engine = new ExecutionPolicyEngine();
    const decision = engine.getRetryDecision({
      phase: 'code',
      error: new Error('socket hang up while fetch'),
    });

    expect(decision.should_retry).toBe(true);
    expect(decision.reason).toBe('message_pattern_retryable');
  });
});
