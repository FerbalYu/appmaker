import { describe, test, expect, beforeAll } from 'bun:test';
import { AgentDispatcher } from '../src/agents/dispatcher.js';
import { PermissionClassifier, PermissionLevel, RiskLevel } from '../src/agents/permission-classifier.js';
import { UniversalToolbox } from '../src/agents/universal-toolbox.js';
import { AgentAdapter } from '../src/agents/base.js';

describe('PermissionClassifier', () => {
  let classifier;

  beforeAll(() => {
    classifier = new PermissionClassifier({
      auto_allow_low_risk: true,
      auto_deny_critical: true
    });
  });

  test('should classify safe file read as auto_allow', async () => {
    const result = await classifier.classify({
      tool_name: 'read_file',
      arguments: { file_path: 'src/index.js' }
    });
    
    expect(result.decision).toBe(PermissionLevel.AUTO_ALLOW);
    expect(result.risk_level).toBeLessThanOrEqual(RiskLevel.LOW);
  });

  test('should classify dangerous command as auto_deny', async () => {
    const result = await classifier.classify({
      tool_name: 'bash_execute',
      arguments: { command: 'rm -rf / --no-preserve-root' }
    });
    
    expect(result.decision).toBe(PermissionLevel.AUTO_DENY);
    expect(result.risk_level).toBe(RiskLevel.CRITICAL);
  });

  test('should classify system path access as high risk', async () => {
    const result = await classifier.classify({
      tool_name: 'read_file',
      arguments: { file_path: '/etc/passwd' }
    });
    
    expect(result.risk_level).toBeGreaterThanOrEqual(RiskLevel.HIGH);
  });

  test('should batch classify multiple tool calls', async () => {
    const calls = [
      { tool_name: 'read_file', arguments: { file_path: 'test.js' } },
      { tool_name: 'bash_execute', arguments: { command: 'ls' } }
    ];
    
    const results = await classifier.classifyBatch(calls);
    
    expect(results).toHaveLength(2);
    expect(results[0].decision).toBe(PermissionLevel.AUTO_ALLOW);
  });
});

describe('UniversalToolbox', () => {
  let toolbox;

  beforeAll(() => {
    toolbox = new UniversalToolbox({
      workspace_root: process.cwd()
    });
  });

  test('should register all tool categories', () => {
    const tools = toolbox.getToolsMetadata();
    
    const categories = new Set(tools.map(t => t.category));
    expect(categories.size).toBeGreaterThanOrEqual(5);
  });

  test('should have file system tools', () => {
    const tools = toolbox.getToolsMetadata();
    const fsTools = tools.filter(t => t.category === 'file_system');
    
    expect(fsTools.length).toBeGreaterThanOrEqual(10);
  });

  test('should have bash tools', () => {
    const tools = toolbox.getToolsMetadata();
    const bashTools = tools.filter(t => t.category === 'bash');
    
    expect(bashTools.length).toBeGreaterThanOrEqual(5);
  });

  test('should have git tools', () => {
    const tools = toolbox.getToolsMetadata();
    const gitTools = tools.filter(t => t.category === 'git');
    
    expect(gitTools.length).toBeGreaterThanOrEqual(4);
  });

  test('should execute file_exists tool', async () => {
    const result = await toolbox.execute('file_exists', { path: 'package.json' });
    
    expect(result.success).toBe(true);
    expect(result.result.exists).toBe(true);
  });

  test('should execute list_directory tool', async () => {
    const result = await toolbox.execute('list_directory', { dir_path: '.' });
    
    expect(result.success).toBe(true);
    expect(result.result.items).toBeDefined();
    expect(Array.isArray(result.result.items)).toBe(true);
  });

  test('should execute bash_execute tool', async () => {
    const result = await toolbox.execute('bash_execute', { command: 'echo "hello"' });
    
    expect(result.success).toBe(true);
    expect(result.result.stdout).toContain('hello');
  });

  test('should handle unknown tool gracefully', async () => {
    const result = await toolbox.execute('unknown_tool', {});
    
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('should block workspace escape path', async () => {
    const result = await toolbox.execute('read_file', { file_path: '../package.json' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('escapes workspace');
  });
});

describe('AgentDispatcher with Toolbox Integration', () => {
  let dispatcher;

  beforeAll(() => {
    dispatcher = new AgentDispatcher({
      workspace_root: process.cwd()
    });
  });

  test('should have permission classifier initialized', () => {
    expect(dispatcher.permissionClassifier).toBeDefined();
    expect(dispatcher.permissionClassifier).toBeInstanceOf(PermissionClassifier);
  });

  test('should have toolbox initialized', () => {
    expect(dispatcher.toolbox).toBeDefined();
    expect(dispatcher.toolbox).toBeInstanceOf(UniversalToolbox);
  });

  test('should get available tools', () => {
    const tools = dispatcher.getAvailableTools();
    
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(20);
  });

  test('should get toolbox status', () => {
    const status = dispatcher.getToolboxStatus();
    
    expect(status.tool_count).toBeGreaterThan(20);
  });

  test('should execute tool with permission check - auto allow', async () => {
    const result = await dispatcher.executeTool('file_exists', { path: 'package.json' });
    
    expect(result.success).toBe(true);
  });

  test('should execute tool with permission check - auto deny', async () => {
    const result = await dispatcher.executeTool('bash_execute', { command: 'rm -rf /' });
    
    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
  });

  test('should get permission stats', () => {
    const stats = dispatcher.getPermissionStats();
    
    expect(stats).toHaveProperty('total_requests');
    expect(stats).toHaveProperty('auto_allowed');
    expect(stats).toHaveProperty('auto_denied');
  });

  test('should shutdown cleanly', async () => {
    try {
      await dispatcher.shutdown();
    } catch {
      // Ignore cleanup errors in test
    }
  });

  test('should enforce permission classifier in agent tool path', async () => {
    class MockAgent extends AgentAdapter {
      constructor() {
        super({
          name: 'mock-agent',
          type: 'test',
          workspace_root: process.cwd(),
        });
      }

      async execute() {
        return this.executeTool('bash_execute', { command: 'rm -rf /' });
      }

      async healthCheck() {
        return true;
      }
    }

    const secureDispatcher = new AgentDispatcher({ workspace_root: process.cwd() });
    secureDispatcher.registerAgent('mock-agent', () => new MockAgent());
    const result = await secureDispatcher.dispatch({
      id: 'mock-task',
      type: 'analysis',
      description: 'security check',
      agent: 'mock-agent',
    });

    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
  });
});
