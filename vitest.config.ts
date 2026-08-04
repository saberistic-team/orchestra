import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: { reporter: ['text', 'json', 'html'] },
    projects: [
      { test: { name: 'unit', include: ['**/*.unit.test.ts'], exclude: ['**/node_modules/**', '**/dist/**'] } },
      { test: { name: 'integration', include: ['**/*.integration.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } },
      { test: { name: 'e2e', include: ['**/*.e2e.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } },
    ],
  },
});

