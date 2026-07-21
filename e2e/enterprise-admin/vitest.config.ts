import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: path.resolve(__dirname),
  test: {
    environment: 'node',
    include: ['support/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
