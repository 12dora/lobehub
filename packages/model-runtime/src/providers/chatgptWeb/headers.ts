import type { RuntimeBrowserDeviceProfile } from '../../browserProfile';
import {
  ACCEPT_IMAGE,
  ACCEPT_JSON,
  ACCEPT_NAVIGATE,
  buildClientHintHeaders,
  buildFetchMetadataHeaders,
  DEFAULT_BROWSER_DEVICE_PROFILE,
  NAVIGATION_ONLY_HEADERS,
  PRIORITY_CORS_PUT,
  PRIORITY_IMAGE,
  PRIORITY_NAVIGATE,
  PRIORITY_XHR,
  userAgentHeaders,
} from '../../browserProfile';
import { randomUuid } from './binary';
import {
  AZURE_BLOB_HEADERS,
  CHATGPT_BASE_URL,
  OAI_CLIENT_BUILD_NUMBER,
  OAI_CLIENT_VERSION,
} from './constants';
import { ChatGPTWebError } from './errors';
import type { ChatRequirements } from './types';

export interface SessionFingerprint {
  accessToken: string;
  browserProfile: RuntimeBrowserDeviceProfile;
  /** Live `OAI-Client-Build-Number` scraped from the bootstrap HTML. */
  clientBuildNumber?: string;
  /** Live `OAI-Client-Version` scraped from the bootstrap HTML. */
  clientVersion?: string;
  deviceId: string;
  sessionId: string;
}

const CRLF_RE = /[\n\r]/;

/**
 * Header values must never carry CR/LF — the injected transport shells out to
 * curl, where a newline in a `-H` value is request splitting.
 *
 * Two policies: values we cannot safely rewrite (the bearer token, the target
 * path/route — truncating them would silently talk to the wrong endpoint or
 * present a mangled credential) are REJECTED; everything else is stripped.
 */
export const rejectCrlf = (name: string, value: string): string => {
  if (CRLF_RE.test(value))
    throw new ChatGPTWebError('upstream', `refusing to send a ${name} header containing CR/LF`);
  return value;
};

export const sanitizeHeaderValue = (value: string): string =>
  value.replaceAll(/[\n\r]/g, ' ').trim();

const sanitizeHeaderRecord = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, sanitizeHeaderValue(value)]),
  );

/** Empty value ⇒ curl-impersonate `-H 'Name:'` deletes the profile leftover. */
const dropNavigationOnly = (headers: Record<string, string>): Record<string, string> => {
  for (const name of NAVIGATION_ONLY_HEADERS) headers[name] = '';
  return headers;
};

/**
 * Headers attached to every chatgpt.com call. `X-OpenAI-Target-Path` /
 * `-Route` are added per request by {@link buildRequestHeaders}.
 */
export const buildSessionHeaders = (fp: SessionFingerprint): Record<string, string> => {
  const profile = fp.browserProfile;
  return dropNavigationOnly({
    'Accept': '*/*',
    ...sanitizeHeaderRecord(userAgentHeaders(profile)),
    // a pasted access token is user input; a mangled bearer must never be sent
    'Authorization': `Bearer ${rejectCrlf('Authorization', fp.accessToken)}`,
    'Cache-Control': 'no-cache',
    'OAI-Client-Build-Number': sanitizeHeaderValue(fp.clientBuildNumber || OAI_CLIENT_BUILD_NUMBER),
    'OAI-Client-Version': sanitizeHeaderValue(fp.clientVersion || OAI_CLIENT_VERSION),
    'OAI-Device-Id': sanitizeHeaderValue(fp.deviceId),
    'OAI-Language': sanitizeHeaderValue(profile.oaiLanguage),
    'OAI-Session-Id': sanitizeHeaderValue(fp.sessionId),
    'Origin': CHATGPT_BASE_URL,
    'Pragma': 'no-cache',
    'Priority': PRIORITY_XHR,
    'Referer': `${CHATGPT_BASE_URL}/`,
    /**
     * chatgpt.com sends no `Accept-CH` / `Critical-CH` (live capture 2026-08-18: the
     * landing page, `/backend-api/me` and `/api/auth/session` all delegate nothing), so
     * a real Chrome only ever presents the low-entropy trio here. Sending
     * `Sec-Ch-Ua-Arch` / `-Platform-Version` / `Device-Memory` / `Dpr` / `Viewport-Width`
     * / `Sec-Ch-Prefers-*` to an origin that never asked is a positive tell — and the
     * pinned curl-impersonate template does not send them natively either.
     */
    ...sanitizeHeaderRecord(buildClientHintHeaders(profile, { entropy: 'low' })),
    ...buildFetchMetadataHeaders('xhr'),
  });
};

/**
 * Same profile-driven Chrome XHR set the runtime presents. Server-side `/backend-api/me`
 * and `/accounts/check` must call this rather than a trimmed copy.
 */
export const buildChatGptWebXhrHeaders = ({
  accessToken,
  browserProfile = DEFAULT_BROWSER_DEVICE_PROFILE,
  deviceId,
  sessionId,
}: {
  accessToken: string;
  browserProfile?: RuntimeBrowserDeviceProfile;
  deviceId: string;
  sessionId: string;
}): Record<string, string> =>
  buildSessionHeaders({ accessToken, browserProfile, deviceId, sessionId });

export interface RequestHeaderOptions {
  extra?: Record<string, string | undefined>;
  /** Concrete path (query string excluded) used for `X-OpenAI-Target-Path`. */
  path: string;
  /** Overrides `X-OpenAI-Target-Route`; the web client sends a template here. */
  route?: string;
}

export const buildRequestHeaders = (
  fp: SessionFingerprint,
  { extra, path, route }: RequestHeaderOptions,
): Record<string, string> => {
  const headers: Record<string, string> = {
    ...buildSessionHeaders(fp),
    // a mangled target path would silently address a different endpoint
    'X-OpenAI-Target-Path': rejectCrlf('X-OpenAI-Target-Path', path),
    'X-OpenAI-Target-Route': rejectCrlf('X-OpenAI-Target-Route', route ?? path),
  };

  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) continue;
    headers[key] = sanitizeHeaderValue(value);
  }

  return headers;
};

/**
 * Document-navigation headers for the `GET https://chatgpt.com/` bootstrap.
 *
 * Deliberately an explicit allowlist rather than the session headers: the
 * bootstrap is a plain HTML navigation, and the reference client presents
 * neither the bearer token nor any `OAI-*` session identifier to it.
 * First navigation: low-entropy `sec-ch-ua*` trio only.
 */
export const buildBootstrapHeaders = (fp: SessionFingerprint): Record<string, string> => ({
  'Accept': ACCEPT_NAVIGATE,
  ...sanitizeHeaderRecord(userAgentHeaders(fp.browserProfile)),
  'Cache-Control': 'no-cache',
  'Priority': PRIORITY_NAVIGATE,
  ...sanitizeHeaderRecord(buildClientHintHeaders(fp.browserProfile, { entropy: 'low' })),
  ...buildFetchMetadataHeaders('navigate'),
});

export interface SentinelHeaderOptions {
  /** `*\/*` for prepare calls, `text/event-stream` for the SSE call. */
  accept?: string;
  conduitToken?: string;
  requirements: ChatRequirements;
  /**
   * The `/f/*` (conduit) variant of the web client omits the turnstile and SO
   * tokens; the plain `/backend-api/conversation` variant sends them. Faithful
   * to the observed traffic.
   */
  variant: 'conversation' | 'conduit';
}

export const buildSentinelHeaders = ({
  accept = 'text/event-stream',
  conduitToken,
  requirements,
  variant,
}: SentinelHeaderOptions): Record<string, string> => {
  const headers: Record<string, string> = dropNavigationOnly({
    'Accept': sanitizeHeaderValue(accept),
    'Content-Type': 'application/json',
    'OpenAI-Sentinel-Chat-Requirements-Token': sanitizeHeaderValue(requirements.token),
  });

  if (requirements.proofToken)
    headers['OpenAI-Sentinel-Proof-Token'] = sanitizeHeaderValue(requirements.proofToken);

  if (variant === 'conversation') {
    if (requirements.turnstileToken)
      headers['OpenAI-Sentinel-Turnstile-Token'] = sanitizeHeaderValue(requirements.turnstileToken);
    if (requirements.soToken)
      headers['OpenAI-Sentinel-SO-Token'] = sanitizeHeaderValue(requirements.soToken);
  } else {
    if (conduitToken) headers['X-Conduit-Token'] = sanitizeHeaderValue(conduitToken);
    if (accept === 'text/event-stream') headers['X-Oai-Turn-Trace-Id'] = randomUuid();
  }

  return headers;
};

/** Headers for the signed Azure blob PUT (they replace the session headers). */
export const buildBlobUploadHeaders = (
  fp: SessionFingerprint,
  mimeType: string,
): Record<string, string> =>
  dropNavigationOnly({
    ...AZURE_BLOB_HEADERS,
    'Accept': ACCEPT_JSON,
    ...sanitizeHeaderRecord(userAgentHeaders(fp.browserProfile)),
    'Content-Type': sanitizeHeaderValue(mimeType),
    'Origin': CHATGPT_BASE_URL,
    'Priority': PRIORITY_CORS_PUT,
    'Referer': `${CHATGPT_BASE_URL}/`,
    ...sanitizeHeaderRecord(buildClientHintHeaders(fp.browserProfile, { entropy: 'low' })),
    ...buildFetchMetadataHeaders('cors-put'),
  });

/**
 * `<img>`-shaped asset download.
 *
 * Same-origin (chatgpt.com estuary, etc.): session XHR set minus Origin, with
 * image/no-cors sec-fetch. The bearer stays — those URLs are not pre-signed.
 *
 * Cross-origin (blob storage, third-party CDNs): an explicit allowlist. A real
 * `<img>` load never sends Authorization, OAI-*, or X-OpenAI-Target-*.
 */
export const buildAssetDownloadHeaders = (
  fp: SessionFingerprint,
  { sameOrigin }: { sameOrigin: boolean },
): Record<string, string> => {
  if (!sameOrigin) {
    return dropNavigationOnly({
      Accept: ACCEPT_IMAGE,
      ...sanitizeHeaderRecord(userAgentHeaders(fp.browserProfile)),
      Priority: PRIORITY_IMAGE,
      Referer: `${CHATGPT_BASE_URL}/`,
      ...sanitizeHeaderRecord(buildClientHintHeaders(fp.browserProfile, { entropy: 'low' })),
      ...buildFetchMetadataHeaders('image'),
    });
  }

  const headers = buildSessionHeaders(fp);
  delete headers.Origin;
  headers.Accept = ACCEPT_IMAGE;
  headers['Sec-Fetch-Dest'] = 'image';
  headers['Sec-Fetch-Mode'] = 'no-cors';
  headers['Sec-Fetch-Site'] = 'same-origin';
  return headers;
};
