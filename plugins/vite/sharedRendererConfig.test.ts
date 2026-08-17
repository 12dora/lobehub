import { describe, expect, it } from 'vitest';

import { __testing, sharedModulePreload } from './sharedRendererConfig';

describe('sharedModulePreload', () => {
  it('keeps vendor modulepreload dependencies while excluding i18n chunks', () => {
    const resolveDependencies = sharedModulePreload.resolveDependencies!;

    expect(
      resolveDependencies(
        'assets/index.js',
        [
          'assets/vendor-icons.js',
          'vendor/vendor-react.js',
          'i18n/i18n-default.js',
          'assets/i18n-en-US.js',
          'assets/page.js',
        ],
        { hostId: 'index.html', hostType: 'html' },
      ),
    ).toEqual(['assets/vendor-icons.js', 'vendor/vendor-react.js', 'assets/page.js']);
  });
});

describe('sharedManualChunks', () => {
  it('splits auth SPA namespaces into their own per-locale i18n chunks', () => {
    expect(__testing.sharedManualChunks('/repo/locales/zh-CN/auth.json')).toBe('i18n-zh-CN-auth');
    expect(__testing.sharedManualChunks('/repo/locales/zh-CN/common.json')).toBe(
      'i18n-zh-CN-common',
    );
    expect(__testing.sharedManualChunks('/repo/packages/locales/src/default/oauth.ts')).toBe(
      'i18n-default-oauth',
    );
    expect(__testing.sharedManualChunks('/repo/locales/zh-CN/models.json')).toBe(
      'i18n-zh-CN-models',
    );
  });

  it('gives every default namespace its own chunk', () => {
    // create.ts imports these four statically; a shared `i18n-src` chunk would
    // drag all 53 default namespaces (~2.4MB) into the first-screen graph.
    expect(__testing.sharedManualChunks('/repo/packages/locales/src/default/chat.ts')).toBe(
      'i18n-default-chat',
    );
    expect(__testing.sharedManualChunks('/repo/packages/locales/src/default/home.ts')).toBe(
      'i18n-default-home',
    );
    expect(__testing.sharedManualChunks('/repo/packages/locales/src/default/plugin.ts')).toBe(
      'i18n-default-plugin',
    );
  });

  it('splits the statically bundled namespaces out of the merged locale chunk', () => {
    expect(__testing.sharedManualChunks('/repo/locales/zh-CN/chat.json')).toBe('i18n-zh-CN-chat');
    expect(__testing.sharedManualChunks('/repo/locales/zh-CN/home.json')).toBe('i18n-zh-CN-home');
    expect(__testing.sharedManualChunks('/repo/locales/zh-CN/plugin.json')).toBe('i18n-zh-CN');
  });

  it('keeps antd / dayjs locale data out of the app locale bundle', () => {
    // dayjs' CJS core is pulled into whichever chunk holds a dayjs locale; when
    // that chunk was `i18n-ar` the entry statically imported 0.91MB of Arabic
    // app translations on every page load.
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/antd@5/node_modules/antd/es/locale/ar_EG.js',
      ),
    ).toBe('i18n-vendor-ar');
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/dayjs@1/node_modules/dayjs/locale/zh-cn.js',
      ),
    ).toBe('i18n-vendor-zh-CN');
  });

  it('isolates the diff viewer / syntax highlighting vendors', () => {
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/@pierre+diffs@1/node_modules/@pierre/diffs/dist/react/index.js',
      ),
    ).toBe('vendor-diff');
    // shiki itself stays ungrouped: grouping its dist modules duplicates the
    // 1.28MB language/theme info tables into a second eager chunk (measured).
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/shiki@3/node_modules/shiki/dist/langs.mjs',
      ),
    ).toBeUndefined();
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/shiki@3/node_modules/shiki/dist/langs/cpp.mjs',
      ),
    ).toBeUndefined();
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/shiki@3/node_modules/@shikijs/langs/dist/cpp.mjs',
      ),
    ).toBeUndefined();
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/three@0/node_modules/three/build/three.module.js',
      ),
    ).toBe('vendor-three');
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/recharts@2/node_modules/recharts/es6/index.js',
      ),
    ).toBe('vendor-charts');
  });

  it('keeps locale runtime helpers out of the default locale chunk', () => {
    expect(__testing.sharedManualChunks('/repo/packages/locales/src/resources.ts')).toBe(undefined);
    expect(__testing.sharedManualChunks('/repo/packages/locales/src/create.ts')).toBe(undefined);
  });

  it('groups shared constants into a dedicated chunk', () => {
    expect(__testing.sharedManualChunks('/repo/packages/const/src/url.ts')).toBe('app-const');
  });

  it('groups stable runtime packages into coarse vendor chunks', () => {
    expect(
      __testing.sharedManualChunks('/repo/node_modules/.pnpm/react@19/node_modules/react/index.js'),
    ).toBe('vendor-react');
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/react-dom@19/node_modules/react-dom/client.js',
      ),
    ).toBe('vendor-react');
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/@emotion+react/node_modules/@emotion/react/dist/index.js',
      ),
    ).toBe('vendor-ui-runtime');
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/motion@12/node_modules/motion/react/dist/index.js',
      ),
    ).toBe('vendor-ui-runtime');
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/lucide-react/node_modules/lucide-react/dist/index.js',
      ),
    ).toBe('vendor-icons');
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/zustand@5/node_modules/zustand/esm/index.mjs',
      ),
    ).toBe('vendor-data-runtime');
    expect(
      __testing.sharedManualChunks('/repo/packages/model-runtime/src/providers/openai/index.ts'),
    ).toBe('vendor-ai-runtime');
    expect(
      __testing.sharedManualChunks(
        '/repo/node_modules/.pnpm/openai@4/node_modules/openai/index.mjs',
      ),
    ).toBe('vendor-ai-runtime');
  });
});
