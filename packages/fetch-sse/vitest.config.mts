import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Repo-wide tsconfig path used by shared platform constants
      // (`@/const/platform/*` → packages/const/src/platform/*).
      '@/const': fileURLToPath(new URL('../const/src', import.meta.url)),
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov', 'text-summary'],
    },
    environment: 'happy-dom',
  },
});
