import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { dockerTracingExcludes } from './dockerTracingExcludes';

describe('dockerTracingExcludes', () => {
  it('must not match node_modules/**/dist/** (picomatch contains:true)', async () => {
    // @ts-expect-error -- next/dist/compiled/picomatch ships no type declarations
    const { default: picomatch } = await import('next/dist/compiled/picomatch');
    const isMatch = picomatch(dockerTracingExcludes(), { contains: true, dot: true });
    const root = '/app';
    const mustKeep = [
      path.join(
        root,
        'node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js',
      ),
      path.join(
        root,
        'node_modules/.pnpm/es-toolkit@1.0.0/node_modules/es-toolkit/dist/compat/index.mjs',
      ),
      path.join(root, 'src/app/page.tsx'),
    ];
    const mustDrop = [
      path.join(root, 'dist/desktop/index.html'),
      path.join(root, 'dist/mobile/assets/index.js'),
      path.join(root, 'dist/auth/index.html'),
      path.join(root, 'apps/desktop/package.json'),
      path.join(root, 'apps/cli/src/index.ts'),
      path.join(
        root,
        'node_modules/.pnpm/@napi-rs+canvas@0.1.100/node_modules/@napi-rs/canvas-linux-arm64-gnu/skia.linux-arm64-gnu.node',
      ),
      path.join(
        root,
        'node_modules/.pnpm/@napi-rs+canvas-linux-arm64-gnu@0.1.100/node_modules/@napi-rs/canvas-linux-arm64-gnu/skia.linux-arm64-gnu.node',
      ),
    ];
    const mustKeepNative = [
      path.join(root, 'node_modules/@napi-rs/canvas-linux-arm64-gnu/skia.linux-arm64-gnu.node'),
      path.join(root, 'node_modules/@napi-rs/canvas/index.js'),
    ];
    for (const file of [...mustKeep, ...mustKeepNative]) {
      expect(isMatch(file), file).toBe(false);
    }
    for (const file of mustDrop) {
      expect(isMatch(file), file).toBe(true);
    }
  });
});
