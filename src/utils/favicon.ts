const RUNTIME_BRANDING_REVISION_PARAM = 'runtime_branding_revision';

export type FaviconState = 'default' | 'done' | 'error' | 'progress';

const stateToFileName: Record<FaviconState, string> = {
  default: '',
  done: '-done',
  error: '-error',
  progress: '-progress',
};

const getFaviconPath = (state: FaviconState, isDev: boolean, size?: '32x32'): string => {
  const devSuffix = isDev ? '-dev' : '';
  const stateSuffix = stateToFileName[state];
  const sizeSuffix = size ? `-${size}` : '';
  return `/favicon${sizeSuffix}${stateSuffix}${devSuffix}.ico`;
};

/** Preserves an asset URL's existing query/hash while adding a branding cache key. */
export const withRuntimeBrandingRevision = (url: string, revision: string | null): string => {
  if (!revision) return url;

  const isRootRelative = url.startsWith('/');
  const parsed = new URL(url, 'https://runtime-branding.invalid');
  parsed.searchParams.set(RUNTIME_BRANDING_REVISION_PARAM, revision);

  return isRootRelative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
};

export const resolveFaviconHref = (
  state: FaviconState,
  isDev: boolean,
  runtimeFaviconUrl: string | null,
  publishedRevision: string | null,
  size?: '32x32',
  now = Date.now(),
): string => {
  // A published favicon owns the tab in every state: swapping in the built-in
  // status icon would flash the product brand at a white-labelled platform.
  if (runtimeFaviconUrl) {
    return withRuntimeBrandingRevision(runtimeFaviconUrl, publishedRevision);
  }

  return `${getFaviconPath(state, isDev, size)}?v=${now}`;
};
