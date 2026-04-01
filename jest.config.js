/**
 * Jest Configuration for appMaker
 * @see https://jestjs.io/docs/configuration
 */
export default {
  // Test environment
  testEnvironment: 'node',

  // Test files pattern
  testMatch: ['**/tests/**/*.test.js', '**/tests/**/*.spec.js', '**/?(*.)+(spec|test).js'],

  // Files to ignore
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/build/', '/coverage/'],

  // Coverage configuration
  collectCoverage: true,
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!src/**/index.js',
    '!**/node_modules/**',
    '!**/vendor/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 60,
      lines: 60,
      statements: 60,
    },
  },

  // Setup files
  setupFilesAfterEnv: ['./tests/setup.js'],

  // Module paths
  modulePaths: ['<rootDir>'],
  roots: ['<rootDir>/src', '<rootDir>/tests'],

  // Transform
  transform: {},

  // Timeout
  testTimeout: 10000,

  // Verbose output
  verbose: true,

  // Detect open handles
  detectOpenHandles: true,
  forceExit: true,

  // Clear mocks
  clearMocks: true,
  restoreMocks: true,

  // reporters
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: 'coverage',
        outputName: 'junit.xml',
      },
    ],
  ],
};
