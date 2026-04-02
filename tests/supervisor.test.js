const EventEmitter = require('events');
const { Supervisor } = require('../src/supervisor');

describe('Supervisor', () => {
  it('should assess risk based on error limits', () => {
    const mockEngine = new EventEmitter();
    const supervisor = new Supervisor(mockEngine, {
      maxErrors: 5
    });

    supervisor.metrics.errors = [
      { error: 'e1' },
      { error: 'e2' },
      { error: 'e3' },
      { error: 'e4' },
      { error: 'e5' },
      { error: 'e6' }
    ];
    supervisor.assessRisk();
    expect(mockEngine.halt).toBe(true);
  });

  it('should trigger correction on task error', async () => {
    const mockEngine = new EventEmitter();
    const supervisor = new Supervisor(mockEngine, {});
    
    // Mock or spy the method
    const spy = jest.spyOn(supervisor, 'triggerCorrection');
    // Also mock corrector to prevent side-effects since constructor instantiates it
    supervisor.corrector = { correct: jest.fn().mockResolvedValue({ success: true }) };
    
    mockEngine.emit('task:error', { task: { id: 't1' }, result: { error: 'mock error' }, phase: 'test' });
    
    expect(spy).toHaveBeenCalledWith('error', { task: { id: 't1' }, error: 'mock error' });
  });
});
