import { defineConfig } from './src/libs/next/config/define-config';

const isVercel = !!process.env.VERCEL_ENV;

const vercelConfig = {
  // Vercel serverless optimization: exclude musl binaries from all routes
  // Vercel uses Amazon Linux (glibc), not Alpine Linux (musl)
  // This saves ~45MB (29MB canvas-musl + 16MB sharp-musl) per serverless function
  outputFileTracingExcludes: {
    '*': [
      'node_modules/.pnpm/@napi-rs+canvas-*-musl*',
      'node_modules/.pnpm/@img+sharp-libvips-*musl*',
      // Exclude SPA/desktop/mobile build artifacts from serverless functions
      'public/_spa/**',
      'dist/desktop/**',
      'dist/mobile/**',
      'apps/desktop/**',
      'packages/database/migrations/**',
    ],
  },
};
// defineConfig only accepts a narrow CustomNextConfig and does not forward distDir.
// Apply the E2E-owned distDir on the final NextConfig object so suite builds never
// write into the main `.next` tree (root type-check stays valid after E2E).
const nextConfig = defineConfig({
  ...(isVercel ? vercelConfig : {}),
});

export default {
  ...nextConfig,
  ...(process.env.E2E_ENTERPRISE_ADMIN_NEXT_DIST_DIR
    ? { distDir: process.env.E2E_ENTERPRISE_ADMIN_NEXT_DIST_DIR }
    : {}),
};
