/**
 * Pure helpers shared by the installer (`install.mts`) and its tests. Kept free of side
 * effects so vitest can import them without triggering the download.
 */

/**
 * The musl builds are STATICALLY linked (the gnu ones are not), which is what makes the
 * binary usable inside the distroless/busybox production image as well.
 */
export const ASSET_ARCH: Record<string, string | undefined> = {
  'darwin:arm64': 'arm64-macos',
  'darwin:x64': 'x86_64-macos',
  'linux:arm64': 'aarch64-linux-musl',
  'linux:x64': 'x86_64-linux-musl',
};

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
