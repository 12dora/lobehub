import { describe, expect, it, vi } from 'vitest';

import { dockerCanvasTracingIncludes } from './dockerCanvasTracingIncludes';

describe('defineConfig docker tracing includes', () => {
  it('keeps public/_spa and migrations but not dist/desktop or dist/mobile', async () => {
    vi.stubEnv('DOCKER', 'true');
    vi.stubEnv('NODE_ENV', 'production');

    try {
      const { defineConfig } = await import('./define-config');
      const includes = defineConfig({}).outputFileTracingIncludes?.['*'] ?? [];

      expect(includes).toContain('public/_spa/**');
      expect(includes).toContain('packages/database/migrations/**');
      expect(includes).not.toContain('dist/desktop/**');
      expect(includes).not.toContain('dist/mobile/**');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('dockerCanvasTracingIncludes', () => {
  it('keeps Docker canvas tracing away from pnpm symlink directories', () => {
    expect(dockerCanvasTracingIncludes).toContain('node_modules/@napi-rs/canvas/**/*');
    expect(dockerCanvasTracingIncludes).toContain('node_modules/@napi-rs/canvas-*/package.json');
    expect(dockerCanvasTracingIncludes).toContain('node_modules/@napi-rs/canvas-*/*.node');
    expect(dockerCanvasTracingIncludes).toContain(
      'node_modules/.pnpm/@napi-rs+canvas-*/node_modules/@napi-rs/canvas-*/package.json',
    );
    expect(dockerCanvasTracingIncludes).toContain(
      'node_modules/.pnpm/@napi-rs+canvas-*/node_modules/@napi-rs/canvas-*/*.node',
    );
    expect(dockerCanvasTracingIncludes).not.toContain('node_modules/@napi-rs/canvas-*/**/*');
    expect(dockerCanvasTracingIncludes).not.toContain('node_modules/.pnpm/@napi-rs+canvas*/**/*');
    expect(dockerCanvasTracingIncludes).not.toContain('node_modules/.pnpm/@napi-rs+canvas-*/**/*');
  });
});
