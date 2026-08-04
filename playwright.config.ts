import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'apps/**/tests/flows/*.spec.ts',
  outputDir: '.reports/playwright/results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: '.reports/playwright/html', open: 'never' }]]
    : [['list'], ['html', { outputFolder: '.reports/playwright/html', open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'pnpm --filter @orchestra/web preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
