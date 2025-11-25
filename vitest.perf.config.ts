import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Only include performance tests
    include: ['tests/**/*-perf.test.ts'],
    // Enable garbage collection for accurate memory measurements
    poolOptions: {
      forks: {
        execArgv: ['--expose-gc'],
      },
    },
  },
});
