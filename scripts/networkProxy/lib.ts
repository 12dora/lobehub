/**
 * Pure helpers shared by the installer (`install.mts`) and its tests. Kept free of side
 * effects so vitest can import them without triggering the download.
 */
import {
  NETWORK_PROXY_ENGINE_MANIFEST,
  resolveEnginePlatformKey,
} from '../../packages/const/src/platform/networkProxy';

/**
 * What may be printed about a download URL: scheme + host + port, never userinfo, path or
 * query. A mirror prefix is operator-supplied and may embed `user:password@` (or a signed
 * query), and CI logs are archived and widely readable.
 */
export const sanitizeDownloadOrigin = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '<invalid url>';
  }
};

const isTruthyEnv = (value: string | undefined): boolean =>
  ['1', 'on', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());

export const resolveEngineDownloadBase = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const override = env.NETWORK_PROXY_ENGINE_DOWNLOAD_BASE?.trim();
  if (override) return override.replace(/\/+$/u, '');
  return isTruthyEnv(env.USE_CN_MIRROR)
    ? NETWORK_PROXY_ENGINE_MANIFEST.cnMirrorBaseUrl
    : NETWORK_PROXY_ENGINE_MANIFEST.baseUrl;
};

export const resolveGeodataDownloadBase = (
  env: Record<string, string | undefined> = process.env,
): string =>
  isTruthyEnv(env.USE_CN_MIRROR)
    ? NETWORK_PROXY_ENGINE_MANIFEST.geodata.cnMirrorBaseUrl
    : NETWORK_PROXY_ENGINE_MANIFEST.geodata.baseUrl;

export const resolveCurrentEngineAsset = (platform = process.platform, arch = process.arch) => {
  const key = resolveEnginePlatformKey(platform, arch);
  if (!key) return null;
  return { asset: NETWORK_PROXY_ENGINE_MANIFEST.assets[key], key };
};
