/**
 * fetch-compatible transport backed by `curl-impersonate`.
 *
 * chatgpt.com answers Node's own fetch with a Cloudflare bot challenge (403,
 * `cf-mitigated: challenge`) whatever headers are sent — the TLS/HTTP2 fingerprint is
 * what is being checked. Spawning a browser-fingerprinted curl is therefore not an
 * optimisation but the only way the provider works at all.
 *
 * Contract kept deliberately close to WHATWG fetch: a real `Response` with a streaming
 * body, `AbortSignal` support, no redirect following, and undici-shaped network errors.
 */

export { DEFAULT_IMPERSONATE_PROFILE } from './curlConfig';
export {
  createCurlImpersonateFetch,
  type CurlImpersonateFetchOptions,
  drainAllCurlImpersonateChildren,
  drainCurlImpersonateChildren,
  trackedCurlChildCountForTests,
} from './curlImpersonateFetch.cli';
export {
  CHATGPT_WEB_TRANSPORT_ENV,
  type ChatGPTWebFetchOptions,
  type ChatGPTWebTransportPref,
  type ChatGPTWebTransportStatus,
  evictChatGPTWebFetchExcept,
  getChatGPTWebFetch,
  getChatGPTWebTransportStatus,
  resetChatGPTWebFetch,
} from './curlImpersonateFetch.route';
