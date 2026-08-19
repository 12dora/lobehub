/**
 * Pure helpers shared by the installer (`install.mts`) and its tests. Kept free of side
 * effects so vitest can import them without triggering the download.
 */

/**
 * The musl builds are STATICALLY linked (the gnu ones are not), which is what makes the
 * binary usable inside the distroless/busybox production image as well.
 *
 * Library tarballs (see `manifest.json` `libraries`) are keyed by the same values, even
 * though the linux library assets are the dynamically-linked **gnu** builds — koffi loads
 * those, and the musl CLI binary remains the fallback.
 */
export const ASSET_ARCH: Record<string, string | undefined> = {
  'darwin:arm64': 'arm64-macos',
  'darwin:x64': 'x86_64-macos',
  'linux:arm64': 'aarch64-linux-musl',
  'linux:x64': 'x86_64-linux-musl',
};

/** Installed name under `.cache/curl-impersonate/` (regular file, not a versioned symlink). */
export const libraryFileName = (platform: string): string =>
  platform === 'darwin' ? 'libcurl-impersonate.dylib' : 'libcurl-impersonate.so';

/** Written next to the library; compared to `manifest.version` on each install. */
export const LIBRARY_VERSION_MARKER = 'libcurl-impersonate.version';

/**
 * What may be printed about a download URL: scheme + host + port, never userinfo, path or
 * query. A mirror prefix is operator-supplied and may embed `user:password@` (or a signed
 * query), and CI logs are archived and widely readable.
 *
 * Node's `fetch` rejects URLs that still contain userinfo and its TypeError embeds the
 * full URL. Callers must never print a raw fetch exception; use
 * {@link formatDownloadFailure} and send credentials via {@link prepareDownloadRequest}.
 */
export const sanitizeDownloadOrigin = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '<invalid url>';
  }
};

export interface PreparedDownloadRequest {
  headers: Record<string, string>;
  url: string;
}

/**
 * Strip userinfo from the URL (so `fetch` will accept it) and turn it into an explicit
 * `Authorization: Basic` header. Signed query parameters stay on the URL — they are
 * required to fetch the object — but must never be logged.
 */
export const prepareDownloadRequest = (url: string): PreparedDownloadRequest => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('download failed: invalid url');
  }

  const headers: Record<string, string> = {};
  if (parsed.username || parsed.password) {
    const token = Buffer.from(`${parsed.username}:${parsed.password}`, 'utf8').toString('base64');
    headers.Authorization = `Basic ${token}`;
    parsed.username = '';
    parsed.password = '';
  }

  return { headers, url: parsed.href };
};

/** Origin-only download error. Never interpolates the raw URL or a fetch exception. */
export const formatDownloadFailure = (
  url: string,
  status?: { status: number; statusText: string },
): string => {
  const origin = sanitizeDownloadOrigin(url);
  if (status) return `download failed: ${status.status} ${status.statusText} — ${origin}`;
  return `download failed from ${origin}`;
};

/**
 * Turn a caught value into something that may be printed. If the message looks like it
 * came from Node `fetch` (it embeds the URL, userinfo, path, or query), replace it with
 * {@link formatDownloadFailure}.
 */
export const describeCaughtError = (error: unknown, url: string): string => {
  const raw = error instanceof Error ? error.message : 'unknown error';
  if (raw.includes('://') || raw.includes('@')) return formatDownloadFailure(url);
  try {
    const pathname = new URL(url).pathname;
    if (pathname && pathname !== '/' && raw.includes(pathname)) return formatDownloadFailure(url);
  } catch {
    return formatDownloadFailure(url);
  }
  return raw;
};

export const shouldRefreshLibrary = (input: {
  installedVersion: string | undefined;
  libraryExists: boolean;
  manifestVersion: string;
}): boolean => {
  if (!input.libraryExists) return true;
  if (!input.installedVersion) return true;
  return input.installedVersion !== input.manifestVersion;
};
