export interface ConnectPhaseContext {
  /** True when the failure happened before response headers. Default true. */
  beforeHeaders?: boolean;
  /** Proxy URL in use; used to tell proxy-host failures from target-host failures. */
  proxyUrl?: string;
}

interface ConnectPhaseError {
  address?: string;
  cause?: { address?: string; code?: string; hostname?: string; message?: string };
  code?: string;
  errno?: string;
  hostname?: string;
  message?: string;
  statusCode?: number;
}

interface ConnectPhaseFields {
  beforeHeaders: boolean;
  code: string;
  failedHost: string | null;
  message: string;
  proxyHost: string | null;
  statusCode: number | undefined;
}

const hostOf = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return value.replaceAll(/^\[|\]$/g, '').toLowerCase() || null;
  }
};

const failedHostOf = (error: {
  address?: string;
  cause?: { address?: string; hostname?: string };
  hostname?: string;
  message?: string;
}): string | null => {
  const raw = error.hostname ?? error.cause?.hostname ?? error.address ?? error.cause?.address;
  if (raw) return hostOf(typeof raw === 'string' ? `http://${raw}` : undefined) ?? String(raw);
  const match = /(?:getaddrinfo\s+\w+\s+|connect\s+\w+\s+)([\w.:-]+)/i.exec(error.message ?? '');
  return match?.[1]?.toLowerCase() ?? null;
};

const connectPhaseContext = (
  error: ConnectPhaseError,
  ctx: ConnectPhaseContext,
): ConnectPhaseFields => {
  return {
    beforeHeaders: ctx.beforeHeaders !== false,
    code: error.code ?? error.errno ?? error.cause?.code ?? '',
    failedHost: failedHostOf(error),
    message: `${error.message ?? ''} ${error.cause?.message ?? ''}`.toLowerCase(),
    proxyHost: hostOf(ctx.proxyUrl),
    statusCode: error.statusCode,
  };
};

const isTargetSideTls = (code: string): boolean =>
  code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';

const isPostHeaderSocket = (code: string, beforeHeaders: boolean): boolean =>
  code === 'UND_ERR_SOCKET' && !beforeHeaders;

const isProxyAuthFailure = (statusCode: number | undefined, message: string): boolean =>
  statusCode === 407 || message.includes('407') || message.includes('proxy authentication');

const isConnectTimeout = (code: string, beforeHeaders: boolean): boolean =>
  code === 'UND_ERR_CONNECT_TIMEOUT' && beforeHeaders;

const isProxyTlsFailure = (
  code: string,
  message: string,
  beforeHeaders: boolean,
  proxyHost: string | null,
  failedHost: string | null,
): boolean =>
  (code === 'UND_ERR_TLS' || message.includes('tls')) &&
  beforeHeaders &&
  (message.includes('proxy') || Boolean(proxyHost && failedHost === proxyHost));

/** `undefined` = not this class; otherwise the decisive host / beforeHeaders result. */
const isProxyUnreachable = (
  code: string,
  proxyHost: string | null,
  failedHost: string | null,
  beforeHeaders: boolean,
): boolean | undefined => {
  if (
    code !== 'ECONNREFUSED' &&
    code !== 'ETIMEDOUT' &&
    code !== 'EHOSTUNREACH' &&
    code !== 'ENETUNREACH'
  ) {
    return undefined;
  }
  if (proxyHost && failedHost) return failedHost === proxyHost;
  return beforeHeaders;
};

/** `undefined` = not this class; otherwise hosts-must-match. */
const isProxyDnsFailure = (
  code: string,
  proxyHost: string | null,
  failedHost: string | null,
): boolean | undefined => {
  if (code !== 'ENOTFOUND' && code !== 'EAI_AGAIN') return undefined;
  return Boolean(proxyHost && failedHost && failedHost === proxyHost);
};

const isProxyHandshakeMessage = (message: string): boolean =>
  message.includes('proxy') && (message.includes('timeout') || message.includes('handshake'));

/**
 * True only for *proxy-connect-stage* failures. Target-side TLS / DNS / post-header
 * socket errors must not open the outlet breaker.
 */
export const isConnectPhaseFailure = (error: unknown, ctx: ConnectPhaseContext = {}): boolean => {
  if (!error || typeof error !== 'object') return false;
  const { beforeHeaders, code, failedHost, message, proxyHost, statusCode } = connectPhaseContext(
    error as ConnectPhaseError,
    ctx,
  );

  if (isTargetSideTls(code)) return false;
  if (isPostHeaderSocket(code, beforeHeaders)) return false;
  if (isProxyAuthFailure(statusCode, message)) return true;
  if (isConnectTimeout(code, beforeHeaders)) return true;
  if (isProxyTlsFailure(code, message, beforeHeaders, proxyHost, failedHost)) return true;
  const unreachable = isProxyUnreachable(code, proxyHost, failedHost, beforeHeaders);
  if (unreachable !== undefined) return unreachable;
  const dns = isProxyDnsFailure(code, proxyHost, failedHost);
  if (dns !== undefined) return dns;
  if (isProxyHandshakeMessage(message)) return true;
  return false;
};
