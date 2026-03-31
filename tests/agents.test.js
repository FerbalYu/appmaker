import { AgentDispatcher } from '../src/agents/dispatcher.js';
import { NativeCoderAdapter } from '../src/agents/native-coder.js';
import { NativeReviewerAdapter } from '../src/agents/native-reviewer.js';

describe('Agents & Dispatcher', () => {
  it('should initialize NativeCoderAdapter and NativeReviewerAdapter', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const reviewer = new NativeReviewerAdapter({ api_key: 'test-key' });
    expect(coder.name).toBe('native-coder');
    expect(reviewer.name).toBe('native-reviewer');
  });

  it('should register and retrieve agent in dispatcher', () => {
    const dispatcher = new AgentDispatcher();
    const mockAgent = { execute: jest.fn() };
    dispatcher.registerAgent('test-agent', mockAgent);
    expect(dispatcher.agents.get('test-agent')).toBe(mockAgent);
    dispatcher.unregisterAgent('test-agent');
    expect(dispatcher.agents.get('test-agent')).toBeUndefined();
  });

  it('should extract JSON correctly in NativeCoderAdapter', () => {
    const coder = new NativeCoderAdapter({ api_key: 'test-key' });
    const result1 = coder._extractJSON('```json\n{"a":1}\n```');
    expect(result1.a).toBe(1);
    const result2 = coder._extractJSON('{"b":2}');
    expect(result2.b).toBe(2);
    const result3 = coder._extractJSON('Here is your json\n```\n{"c":3}\n```');
    expect(result3.c).toBe(3);
  });
});
