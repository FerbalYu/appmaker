/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

/**
 * Vitest Configuration for appMaker (alternative test runner)
 * @see https://vitest.dev/config/
 */
export default defineConfig({
  test: {
    // Test environment
    environment: 'node',

    // Test files
    include: ['tests/**/*.test.js', 'tests/**/*.spec.js', '**/?(*.)+(spec|test).js'],

    // Exclude patterns
    exclude: ['node_modules/**', 'dist/**', 'build/**', 'coverage/**', '**/*.config.js'],

    // Coverage
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      exclude: ['node_modules/**', 'dist/**', '**/*.config.js', 'coverage/**', 'tests/**'],
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60,
      },
    },

    // Setup
    setupFiles: ['./tests/setup.js'],

    // Timeout
    testTimeout: 10000,
    hookTimeout: 10000,

    // Reporters
    reporters: ['default', 'verbose'],

    // Output
    outputFile: {
      junit: 'coverage/junit.xml',
    },

    // Mock
    mockReset: true,
    clearMocks: true,

    // UI
    ui: false,

    // Watch
    watch: false,
  },

  // Resolve
  resolve: {
    alias: {
      '@': './src',
      '@tests': './tests',
      '@config': './config',
    },
  },
});
