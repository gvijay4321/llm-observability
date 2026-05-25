import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/ingestion/src/**/*.test.ts'],
    // Throwaway DB so tests never touch dev.
    env: {
      DATABASE_URL: 'file:./data/vitest.sqlite',
      QUEUE_DRIVER: 'memory',
      INGESTION_API_KEY: '',
    },
    testTimeout: 15_000,
  },
});
