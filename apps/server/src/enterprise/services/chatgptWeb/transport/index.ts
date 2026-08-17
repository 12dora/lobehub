// Register the network-proxy egress ALS / ssrf-safe-fetch binding whenever this
// transport (pulled in by ModelRuntime) is loaded.
import '../../networkProxy/egress/scope';

export {
  createCurlImpersonateFetch,
  type CurlImpersonateFetchOptions,
  DEFAULT_IMPERSONATE_PROFILE,
  getChatGPTWebFetch,
  resetChatGPTWebFetch,
} from './curlImpersonateFetch';
export {
  ChatGPTWebTransportPolicyError,
  ChatGPTWebTransportUnavailableError,
  isChatGPTWebTransportUnavailableError,
} from './errors';
export {
  CURL_IMPERSONATE_BIN_ENV,
  resetCurlImpersonateBinaryCache,
  resolveCurlImpersonateBinary,
} from './resolveBinary';
