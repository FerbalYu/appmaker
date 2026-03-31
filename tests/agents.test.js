const { AgentDispatcher } = require('../src/agents/dispatcher');
const { OpenCodeAdapter } = require('../src/agents/opencode');
const { ClaudeCodeAdapter } = require('../src/agents/claude-code');

describe('Agents & Dispatcher', () => {
  it('should initialize OpenCodeAdapter and ClaudeCodeAdapter', () => {
    const opencode = new OpenCodeAdapter({ use_cli: false });
    const claude = new ClaudeCodeAdapter({ use_cli: false });
    expect(opencode.cliPath).toBeDefined();
    expect(claude.model).toBeDefined();
  });

  it('should register and retrieve agent in dispatcher', () => {
    const dispatcher = new AgentDispatcher();
    const mockAgent = { execute: jest.fn() };
    dispatcher.registerAgent('test-agent', mockAgent);
    expect(dispatcher.agents.get('test-agent')).toBe(mockAgent);
    dispatcher.unregisterAgent('test-agent');
    expect(dispatcher.agents.get('test-agent')).toBeUndefined();
  });

  it('should extract JSON correctly in ClaudeCodeAdapter', () => {
    const claude = new ClaudeCodeAdapter({ use_cli: false });
    expect(claude._extractJSON('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(claude._extractJSON('{"b":2}')).toBe('{"b":2}');
    // Nested or messy output
    expect(claude._extractJSON('Here is your json\n```\n{"c":3}\n```')).toBe('{"c":3}');
  });
});
