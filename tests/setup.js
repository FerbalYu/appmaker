/**
 * Jest/Vitest Setup File
 * Runs before each test file
 */

// Set test environment
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

// Mock console for cleaner test output
// Uncomment if you want to suppress console in tests:
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
//   error: jest.fn(),
// };

// Global test utilities
global.testUtils = {
  /**
   * Create a mock agent response
   */
  mockAgentResponse: (overrides = {}) => ({
    id: `test-agent-${Date.now()}`,
    status: 'success',
    payload: {},
    timestamp: Date.now(),
    ...overrides
  }),
  
  /**
   * Create a mock task
   */
  mockTask: (overrides = {}) => ({
    id: `task-${Date.now()}`,
    description: 'Test task',
    status: 'pending',
    dependencies: [],
    ...overrides
  }),
  
  /**
   * Create a mock plan
   */
  mockPlan: (overrides = {}) => ({
    id: `plan-${Date.now()}`,
    tasks: [],
    milestones: [],
    dependencies: {},
    ...overrides
  }),
  
  /**
   * Create a mock file
   */
  mockFile: (overrides = {}) => ({
    path: 'src/test.js',
    action: 'create',
    content: '// test',
    ...overrides
  })
};

// Increase timeout for async tests
jest.setTimeout(10000);

// Clean up after all tests
afterAll(async () => {
  // Add any global cleanup here
});

// Mock file system operations
jest.mock('fs', () => {
  const originalFs = jest.requireActual('fs');
  return {
    ...originalFs,
    promises: {
      ...originalFs.promises,
      readFile: jest.fn(),
      writeFile: jest.fn(),
      mkdir: jest.fn(),
      rm: jest.fn(),
      readdir: jest.fn(),
      stat: jest.fn()
    }
  };
});
