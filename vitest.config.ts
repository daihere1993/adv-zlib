import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      reporter: ['text', 'html'],
      provider: 'v8',
    },
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Exclude performance tests by default (run them with test:perf script)
    exclude: ['**/node_modules/**', '**/dist/**', '**/*-perf.test.ts'],
  },
});
