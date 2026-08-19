import { describe, expect, it, vi } from 'vitest';

import { dockerCanvasTracingIncludes } from './dockerCanvasTracingIncludes';
import { dockerKoffiTracingIncludes } from './dockerKoffiTracingIncludes';

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
      for (const entry of dockerKoffiTracingIncludes) {
        expect(includes).toContain(entry);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps koffi on the server-external list so the native addon is not bundled', async () => {
    const { defineConfig } = await import('./define-config');
    expect(defineConfig({}).serverExternalPackages).toContain('koffi');
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

describe('dockerKoffiTracingIncludes', () => {
  it('keeps Docker koffi tracing away from pnpm symlink directories', () => {
    expect(dockerKoffiTracingIncludes).toContain('node_modules/koffi/**/*');
    expect(dockerKoffiTracingIncludes).toContain(
      'node_modules/@koromix/koffi-linux-*/package.json',
    );
    expect(dockerKoffiTracingIncludes).toContain('node_modules/@koromix/koffi-linux-*/index.js');
    expect(dockerKoffiTracingIncludes).toContain(
      'node_modules/@koromix/koffi-linux-*/*/koffi.node',
    );
    expect(dockerKoffiTracingIncludes).toContain(
      'node_modules/.pnpm/@koromix+koffi-linux-*/node_modules/@koromix/koffi-linux-*/package.json',
    );
    expect(dockerKoffiTracingIncludes).toContain(
      'node_modules/.pnpm/@koromix+koffi-linux-*/node_modules/@koromix/koffi-linux-*/*/koffi.node',
    );
    expect(dockerKoffiTracingIncludes).toContain(
      'node_modules/.pnpm/koffi@*/node_modules/koffi/**/*',
    );
    expect(dockerKoffiTracingIncludes).not.toContain('node_modules/@koromix/koffi-linux-*/**/*');
    expect(dockerKoffiTracingIncludes).not.toContain('node_modules/.pnpm/@koromix+koffi*/**/*');
    expect(dockerKoffiTracingIncludes).not.toContain(
      'node_modules/.pnpm/@koromix+koffi-linux-*/**/*',
    );
  });
});
