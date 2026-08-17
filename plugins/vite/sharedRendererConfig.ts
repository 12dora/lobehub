import react from '@vitejs/plugin-react';
import { codeInspectorPlugin } from 'code-inspector-plugin';
import type { ModulePreloadOptions } from 'vite';

import { viteEmotionSpeedy } from './emotionSpeedy';
import { viteMarkdownImport } from './markdownImport';
import { viteNodeModuleStub } from './nodeModuleStub';
import { vitePlatformResolve } from './platformResolve';
import { routeChunkPreload } from './routeChunkPreload';

/**
 * Shared manual chunk naming — groups leaf-node modules to reduce chunk file count.
 * Only targets pure data modules (no downstream dependents) to avoid facade chunk issues.
 */
/** Large i18n namespaces that get their own per-locale chunk instead of merging into the locale bundle */
const HEAVY_NS = new Set(['models', 'modelProvider']);

/**
 * Namespaces loaded by the auth SPA (see createAuthI18n). They get their own
 * per-locale chunk so the auth page never pulls the merged locale bundle of the
 * main app, and both SPAs share the same chunk URLs for these namespaces.
 */
const AUTH_NS = new Set(['auth', 'authError', 'common', 'error', 'marketAuth', 'oauth']);

/**
 * Namespaces `packages/locales/src/create.ts` imports statically so the first
 * render has synchronous fallback copy. Without a dedicated chunk they drag the
 * whole merged locale bundle (~0.9MB per language) into the entry's static
 * graph, which every visitor then downloads before first paint.
 */
const BUNDLED_NS = new Set(['chat', 'home']);

const isSplitNamespace = (ns: string) => AUTH_NS.has(ns) || BUNDLED_NS.has(ns) || HEAVY_NS.has(ns);

/** antd locale filename → app locale */
const ANTD_LOCALE: Record<string, string> = {
  ar_EG: 'ar',
  bg_BG: 'bg-BG',
  de_DE: 'de-DE',
  en_US: 'en-US',
  es_ES: 'es-ES',
  fa_IR: 'fa-IR',
  fr_FR: 'fr-FR',
  it_IT: 'it-IT',
  ja_JP: 'ja-JP',
  ko_KR: 'ko-KR',
  nl_NL: 'nl-NL',
  pl_PL: 'pl-PL',
  pt_BR: 'pt-BR',
  ru_RU: 'ru-RU',
  tr_TR: 'tr-TR',
  vi_VN: 'vi-VN',
  zh_CN: 'zh-CN',
  zh_TW: 'zh-TW',
};

/** dayjs locale filename → app locale */
const DAYJS_LOCALE: Record<string, string> = {
  'ar': 'ar',
  'bg': 'bg-BG',
  'de': 'de-DE',
  'en': 'en-US',
  'es': 'es-ES',
  'fa': 'fa-IR',
  'fr': 'fr-FR',
  'it': 'it-IT',
  'ja': 'ja-JP',
  'ko': 'ko-KR',
  'nl': 'nl-NL',
  'pl': 'pl-PL',
  'pt-br': 'pt-BR',
  'ru': 'ru-RU',
  'tr': 'tr-TR',
  'vi': 'vi-VN',
  'zh-cn': 'zh-CN',
  'zh-tw': 'zh-TW',
};

const isNodePackage = (id: string, packageName: string) => {
  const normalized = id.replaceAll('\\', '/');

  return normalized.includes(`/node_modules/${packageName}/`);
};

function sharedManualChunks(id: string): string | undefined {
  // default locale sources live in packages/locales/src/default — one chunk per
  // namespace, so the four namespaces create.ts imports statically no longer
  // pull all 53 default namespaces (2.4MB) into the first-screen graph
  const defaultLocaleMatch = id.match(/\/locales\/src\/default\/([^/.]+)/);
  if (defaultLocaleMatch) return `i18n-default-${defaultLocaleMatch[1]}`;

  // runtime helpers (resources/create/utils) in packages/locales/src must not
  // share a chunk with the default locale data, or every consumer would
  // statically pull the whole default bundle
  if (id.includes('/locales/src/')) return;

  // i18n locale JSON/TS files
  const localeMatch = id.match(/\/locales\/([^/]+)\/([^/.]+)/);
  if (localeMatch) {
    const [, locale, ns] = localeMatch;
    if (isSplitNamespace(ns)) return `i18n-${locale}-${ns}`;
    if (locale === 'default') return 'i18n-default';
    return `i18n-${locale}`;
  }

  if (id.includes('/packages/model-runtime/') || isNodePackage(id, 'openai'))
    return 'vendor-ai-runtime';

  // shared constants would otherwise be captured into vendor-ai-runtime,
  // dragging the whole AI chunk into the auth SPA's static graph
  if (id.includes('/packages/const/src/')) return 'app-const';

  // model-bank (monorepo package — split before node_modules guard)
  if (id.includes('model-bank')) return 'providerConfig';

  if (!id.includes('node_modules')) return;

  // antd / dayjs locale data lives in its own per-locale chunk. It must NOT be
  // merged into the app's `i18n-{locale}` bundle: dayjs' CJS core gets pulled
  // into whichever chunk holds a dayjs locale, and because the core is on the
  // entry's static graph that made every visitor download a full foreign
  // language bundle (measured: `i18n-ar` 0.91MB eagerly imported by the entry).
  const antdMatch = id.match(/antd\/es\/locale\/([^/.]+)\.js/);
  if (antdMatch) {
    const locale = ANTD_LOCALE[antdMatch[1]];
    if (locale) return `i18n-vendor-${locale}`;
  }

  const dayjsMatch = id.match(/dayjs\/locale\/([^/.]+)\.js/);
  if (dayjsMatch) {
    const locale = DAYJS_LOCALE[dayjsMatch[1]];
    if (locale) return `i18n-vendor-${locale}`;
  }

  // The diff viewer ships its own shiki copy with every bundled grammar and
  // theme. Pin it to a dedicated chunk so it can never be merged back into a
  // shared first-screen chunk (it was, and cost 7.9MB); the call sites load it
  // through `@/components/LazyDiff`.
  //
  // The chunk is still pulled eagerly, but only because the bundler co-locates
  // shiki's language/theme *metadata* with it and `@lobehub/ui`'s
  // `Highlighter/const.mjs` imports `bundledLanguagesInfo` / `bundledThemesInfo`
  // statically. Do NOT try to peel that metadata into its own group: measured,
  // a `shiki/dist/*.mjs` group emits a second 1.28MB copy of the info tables
  // (the first stays in the shared chunk) and costs +1.19MB eager. Removing the
  // edge needs an upstream `@lobehub/ui` change.
  if (isNodePackage(id, '@pierre/diffs')) return 'vendor-diff';

  // three.js (memory role tag cloud) and recharts (stats charts) are never part
  // of a first paint — keep them out of shared chunks so they stay on-demand.
  if (isNodePackage(id, 'three')) return 'vendor-three';
  if (isNodePackage(id, 'recharts') || id.includes('/node_modules/victory-vendor/'))
    return 'vendor-charts';

  if (
    isNodePackage(id, 'react') ||
    isNodePackage(id, 'react-dom') ||
    isNodePackage(id, 'react-router') ||
    isNodePackage(id, 'scheduler')
  ) {
    return 'vendor-react';
  }

  if (
    id.includes('es-toolkit') ||
    id.includes('@emotion/') ||
    id.includes('/motion/') ||
    id.includes('framer-motion')
  ) {
    return 'vendor-ui-runtime';
  }

  if (
    isNodePackage(id, 'dayjs') ||
    isNodePackage(id, 'i18next') ||
    isNodePackage(id, 'react-i18next') ||
    isNodePackage(id, 'swr') ||
    isNodePackage(id, 'zustand')
  ) {
    return 'vendor-data-runtime';
  }

  // Lucide icons
  if (id.includes('lucide-react')) return 'vendor-icons';
}

const sharedChunkFileNames = (chunkInfo: { name: string }) => {
  const { name } = chunkInfo;
  if (name.startsWith('i18n-')) return 'i18n/[name]-[hash].js';
  if (name.startsWith('vendor-')) return 'vendor/[name]-[hash].js';
  return 'assets/[name]-[hash].js';
};

const isI18nChunkFileName = (fileName: string) => {
  const normalized = fileName.split('?')[0].replaceAll('\\', '/');
  const basename = normalized.split('/').at(-1) ?? normalized;

  return normalized.startsWith('i18n/') || basename.startsWith('i18n-');
};

export const sharedModulePreload = {
  resolveDependencies: (_filename, deps) => deps.filter((dep) => !isI18nChunkFileName(dep)),
} satisfies ModulePreloadOptions;

export const sharedRollupOutput = {
  chunkFileNames: sharedChunkFileNames,
  manualChunks: sharedManualChunks,
};

interface SharedRolldownOutputOptions {
  strictExecutionOrder?: boolean;
}

export const createSharedRolldownOutput = (options: SharedRolldownOutputOptions = {}) => ({
  chunkFileNames: sharedChunkFileNames,
  strictExecutionOrder: options.strictExecutionOrder ?? true,
  codeSplitting: {
    groups: [
      {
        name: (moduleId: string) => sharedManualChunks(moduleId) ?? null,
      },
    ],
  },
});

type Platform = 'web' | 'mobile' | 'desktop' | 'auth';

const isDev = process.env.NODE_ENV !== 'production';
const enableRouteChunkPreload = process.env.LOBE_ROUTE_CHUNK_PRELOAD !== 'false';

interface SharedRendererOptions {
  platform: Platform;
  tsconfigPaths?: boolean;
}

export function sharedRendererPlugins(options: SharedRendererOptions) {
  return [
    viteEmotionSpeedy(),
    viteMarkdownImport(),
    viteNodeModuleStub(),
    vitePlatformResolve(options.platform),
    enableRouteChunkPreload && routeChunkPreload(),

    isDev && {
      name: 'lobe-dev-strip-manifest',
      transformIndexHtml: {
        order: 'pre' as const,
        handler: (html: string) => html.replace(/\s*<link\s+rel="manifest"[^>]*>\s*/i, '\n    '),
      },
    },

    isDev &&
      codeInspectorPlugin({
        bundler: 'vite',
        exclude: [/\.(css|json|html)$/],
        hotKeys: ['altKey', 'ctrlKey'],
      }),
    react(),
  ];
}

export function sharedRendererDefine(options: { isElectron: boolean; isMobile: boolean }) {
  const nextPublicDefine = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => key.toUpperCase().startsWith('NEXT_PUBLIC_'))
      .map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)]),
  );

  return {
    '__CI__': process.env.CI === 'true' ? 'true' : 'false',
    '__DEV__': process.env.NODE_ENV !== 'production' ? 'true' : 'false',
    '__ELECTRON__': JSON.stringify(options.isElectron),
    '__MOBILE__': JSON.stringify(options.isMobile),
    '__REACT_SCAN__': process.env.REACT_SCAN === 'true' ? 'true' : 'false',
    '__TEST__': 'false',
    ...nextPublicDefine,
    // Keep a safe fallback so generic `process.env` access won't crash in browser runtime.
    'process.env': '{}',
  };
}

export const sharedOptimizeDeps = {
  include: [
    'react',
    'react-dom',
    'react-dom/client',
    'react-router',
    'react-router/dom',
    'antd',
    '@ant-design/icons',
    '@lobehub/ui',
    '@lobehub/ui > @emotion/react',
    'antd-style',
    'zustand',
    'zustand/middleware',
    'swr',
    'i18next',
    'react-i18next',
    'dayjs',
    'dayjs/locale/ar',
    'dayjs/locale/bg',
    'dayjs/locale/de',
    'dayjs/locale/en',
    'dayjs/locale/es',
    'dayjs/locale/fa',
    'dayjs/locale/fr',
    'dayjs/locale/it',
    'dayjs/locale/ja',
    'dayjs/locale/ko',
    'dayjs/locale/nl',
    'dayjs/locale/pl',
    'dayjs/locale/pt-br',
    'dayjs/locale/ru',
    'dayjs/locale/tr',
    'dayjs/locale/vi',
    'dayjs/locale/zh-cn',
    'dayjs/locale/zh-tw',

    'ahooks',
    'motion/react',
  ],
};

export const __testing = {
  sharedManualChunks,
};
