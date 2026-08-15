import { randomUuid } from './binary';
import {
  AZURE_BLOB_HEADERS,
  CHATGPT_BASE_URL,
  CHROME_FULL_VERSION,
  DEFAULT_ACCEPT_LANGUAGE,
  DEFAULT_LOCALE,
  DEFAULT_USER_AGENT,
  OAI_CLIENT_BUILD_NUMBER,
  OAI_CLIENT_VERSION,
  SEC_CH_UA,
  SEC_CH_UA_FULL_VERSION_LIST,
  SEC_CH_UA_PLATFORM,
  SEC_CH_UA_PLATFORM_VERSION,
} from './constants';
import { ChatGPTWebError } from './errors';
import type { ChatRequirements } from './types';

export interface SessionFingerprint {
  accessToken: string;
  /** Live `OAI-Client-Build-Number` scraped from the bootstrap HTML. */
  clientBuildNumber?: string;
  /** Live `OAI-Client-Version` scraped from the bootstrap HTML. */
  clientVersion?: string;
  deviceId: string;
  locale?: string;
  sessionId: string;
  userAgent?: string;
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

/**
 * Headers attached to every chatgpt.com call. `X-OpenAI-Target-Path` /
 * `-Route` are added per request by {@link buildRequestHeaders}.
 */
export const buildSessionHeaders = (fp: SessionFingerprint): Record<string, string> => {
  const locale = sanitizeHeaderValue(fp.locale || DEFAULT_LOCALE);
  return {
    'Accept-Language': locale === DEFAULT_LOCALE ? DEFAULT_ACCEPT_LANGUAGE : `${locale},en;q=0.9`,
    // a pasted access token is user input; a mangled bearer must never be sent
    'Authorization': `Bearer ${rejectCrlf('Authorization', fp.accessToken)}`,
    'Cache-Control': 'no-cache',
    'OAI-Client-Build-Number': sanitizeHeaderValue(fp.clientBuildNumber || OAI_CLIENT_BUILD_NUMBER),
    'OAI-Client-Version': sanitizeHeaderValue(fp.clientVersion || OAI_CLIENT_VERSION),
    'OAI-Device-Id': sanitizeHeaderValue(fp.deviceId),
    'OAI-Language': locale,
    'OAI-Session-Id': sanitizeHeaderValue(fp.sessionId),
    'Origin': CHATGPT_BASE_URL,
    'Pragma': 'no-cache',
    'Priority': 'u=1, i',
    'Referer': `${CHATGPT_BASE_URL}/`,
    'Sec-Ch-Ua': SEC_CH_UA,
    'Sec-Ch-Ua-Arch': '"x86"',
    'Sec-Ch-Ua-Bitness': '"64"',
    'Sec-Ch-Ua-Full-Version': `"${CHROME_FULL_VERSION}"`,
    'Sec-Ch-Ua-Full-Version-List': SEC_CH_UA_FULL_VERSION_LIST,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Model': '""',
    'Sec-Ch-Ua-Platform': SEC_CH_UA_PLATFORM,
    'Sec-Ch-Ua-Platform-Version': SEC_CH_UA_PLATFORM_VERSION,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': sanitizeHeaderValue(fp.userAgent || DEFAULT_USER_AGENT),
  };
};

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
 */
export const buildBootstrapHeaders = (fp: SessionFingerprint): Record<string, string> => {
  const locale = sanitizeHeaderValue(fp.locale || DEFAULT_LOCALE);
  return {
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': locale === DEFAULT_LOCALE ? DEFAULT_ACCEPT_LANGUAGE : `${locale},en;q=0.9`,
    'Cache-Control': 'no-cache',
    'Sec-Ch-Ua': SEC_CH_UA,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': SEC_CH_UA_PLATFORM,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': sanitizeHeaderValue(fp.userAgent || DEFAULT_USER_AGENT),
  };
};

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
  const headers: Record<string, string> = {
    'Accept': sanitizeHeaderValue(accept),
    'Content-Type': 'application/json',
    'OpenAI-Sentinel-Chat-Requirements-Token': sanitizeHeaderValue(requirements.token),
  };

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
): Record<string, string> => ({
  ...AZURE_BLOB_HEADERS,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.8',
  'Content-Type': sanitizeHeaderValue(mimeType),
  'Origin': CHATGPT_BASE_URL,
  'Referer': `${CHATGPT_BASE_URL}/`,
  'User-Agent': sanitizeHeaderValue(fp.userAgent || DEFAULT_USER_AGENT),
});
