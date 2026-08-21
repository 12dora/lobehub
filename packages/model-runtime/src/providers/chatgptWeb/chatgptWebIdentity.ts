/**
 * Public subpath `@lobechat/model-runtime/chatgptWebIdentity`.
 *
 * Browser facts come from the shared `BrowserDeviceProfile`; this adapter and
 * the builders are re-exported so server auth paths use the same derivations as
 * the runtime.
 */
export * from './browserIdentity';
export {
  buildAssetDownloadHeaders,
  buildBootstrapHeaders,
  buildChatGptWebXhrHeaders,
  buildSessionHeaders,
} from './headers';
export { SENTINEL_BUNDLE_TTL_SEC } from './sentinel';
export type { SentinelBundleBinding, SentinelBundleMintFn } from './sentinelBundlePool';
export { getSharedSentinelBundlePool, resetSharedSentinelBundlePool } from './sentinelBundlePool';
export {
  resetChatGPTWebSentinelKeepWarmForTests,
  SENTINEL_WARM_SKEW_MS,
  startChatGPTWebSentinelKeepWarm,
  stopChatGPTWebSentinelKeepWarm,
} from './sentinelKeepWarm';
export type { ChatGPTWebBootstrapState, ChatGPTWebSessionContext } from './sessionContext';
export { createMemoryChatGPTWebSessionContext } from './sessionContext';
export { COOKIE_JAR_HEADER, deriveSessionId } from './sessionId';
