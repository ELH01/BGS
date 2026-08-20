import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one database; running files sequentially keeps
    // their fixtures from colliding.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
