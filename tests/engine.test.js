const { ExecutionEngine } = require('../src/engine');

describe('ExecutionEngine', () => {
  it('should be instantiable without throwing', () => {
    const engine = new ExecutionEngine({ project_root: '/tmp' });
    expect(engine).toBeInstanceOf(ExecutionEngine);
  });

  it('should maintain state of checkpoints correctly', () => {
    const engine = new ExecutionEngine({ project_root: '/tmp' });
    expect(engine.checkpoints.length).toBe(0);
  });
});
