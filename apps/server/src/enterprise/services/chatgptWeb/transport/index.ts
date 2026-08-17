// Bind egress only when the networkProxy module is on. A static import of
// `egress/scope` would pull the engine + snapshot graph on every ChatGPT Web
// load (and used to run unconditionally via ModelRuntime's static import).
import { bindNetworkProxyEgressIfEnabled } from '../../networkProxy/engine/bindEgress';

bindNetworkProxyEgressIfEnabled();

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
