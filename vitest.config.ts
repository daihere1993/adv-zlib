import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    poolOptions: {
      forks: {
        execArgv: ["--expose-gc"],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['**/*.d.ts', 'src/types.ts', 'src/index.ts'],
      reporter: ['text', 'json', 'html'],
      all: true,
    },
  },
});
