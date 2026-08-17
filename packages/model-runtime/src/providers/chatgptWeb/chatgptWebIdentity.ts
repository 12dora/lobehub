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
export { COOKIE_JAR_HEADER, deriveSessionId } from './sessionId';
