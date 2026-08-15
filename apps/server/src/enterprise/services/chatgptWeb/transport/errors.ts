/**
 * The ChatGPT Web protocol only reaches chatgpt.com behind a browser-grade TLS/HTTP2
 * fingerprint (Cloudflare answers Node's own fetch with a 403 challenge), so every
 * request goes through an external `curl-impersonate` binary. When that binary is not
 * installed the provider is simply unavailable — this is the one stable, actionable
 * error every caller maps onto.
 */
export class ChatGPTWebTransportUnavailableError extends Error {
  /** Stable machine-readable code; never prose. */
  readonly code = 'CHATGPT_WEB_TRANSPORT_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'ChatGPTWebTransportUnavailableError';
  }
}

/**
 * The request was refused by the transport's own destination policy (scheme, host,
 * method, credentials-in-url, body size) BEFORE any process was spawned.
 *
 * The child process is invisible to the enterprise SSRF stack, so this class is the only
 * thing standing between an upstream-controlled URL (signed download links are followed
 * through here) and an arbitrary server-side request. The message names the rule and at
 * most the hostname — never a path, query string or credential.
 */
export class ChatGPTWebTransportPolicyError extends Error {
  /** Stable machine-readable code; never prose. */
  readonly code = 'CHATGPT_WEB_TRANSPORT_POLICY';

  constructor(message: string) {
    super(`ChatGPT Web transport policy: ${message}`);
    this.name = 'ChatGPTWebTransportPolicyError';
  }
}

export const isChatGPTWebTransportUnavailableError = (
  error: unknown,
): error is ChatGPTWebTransportUnavailableError => {
  if (error instanceof ChatGPTWebTransportUnavailableError) return true;
  // Cross-realm / re-thrown copies keep the name + code pair.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'CHATGPT_WEB_TRANSPORT_UNAVAILABLE'
  );
};
