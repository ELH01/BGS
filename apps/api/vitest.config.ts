import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      // The suite legitimately signs in dozens of times from one address. The
      // limiter has its own test that sets its own tight values, so raising it
      // here keeps it from distorting unrelated suites.
      AUTH_RATE_LIMIT_MAX: '10000',
      RATE_LIMIT_MAX: '100000',
    },
  },
});
