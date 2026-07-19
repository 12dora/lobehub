import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    alias: {
      '@/business/server': path.resolve(__dirname, '../business-server/src'),
      '@/config': path.resolve(__dirname, '../app-config/src'),
      '@/const': path.resolve(__dirname, '../const/src'),
      '@/database': path.resolve(__dirname, '../database/src'),
      '@/envs': path.resolve(__dirname, '../env/src'),
      '@/libs/trpc': path.resolve(__dirname, '../trpc/src'),
      '@/locales': path.resolve(__dirname, '../locales/src'),
      '@/server/modules': path.resolve(__dirname, '../../apps/server/src/modules'),
      '@/server/services': path.resolve(__dirname, '../../apps/server/src/services'),
      '@/types': path.resolve(__dirname, '../types/src'),
      '@/utils/errorResponse': path.resolve(__dirname, '../../src/utils/errorResponse'),
      '@/utils/rbac': path.resolve(__dirname, '../../src/utils/rbac'),
      '@/utils': path.resolve(__dirname, '../utils/src'),
      '@': path.resolve(__dirname, '../../src'),
    },
    environment: 'node',
  },
});
