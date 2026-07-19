import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/identity-provider/*.test.ts'],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
