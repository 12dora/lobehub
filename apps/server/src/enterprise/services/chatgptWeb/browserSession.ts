/**
 * ChatGPT Web adapter over the common Browser Session Context (plan C1/G3/G5/G7/C4).
 *
 * Lookup is provider + AIHub connection owner + origin — never the ChatGPT
 * device id. Two stored connections that happen to share an `oai-did` (the same
 * physical browser pasted for two accounts) therefore cannot share a jar,
 * page session id, bootstrap cache, or Sentinel pool slot.
 */

export {
  bindChatGPTWebBrowserSession,
  type BindChatGPTWebBrowserSessionParams,
  buildChatGPTWebBrowserSessionAccountId,
  CHATGPT_WEB_BROWSER_SESSION_ORIGIN,
  CHATGPT_WEB_BROWSER_SESSION_PROVIDER,
  type ChatGPTWebBrowserSessionOwner,
  installBrowserSessionRegistryForTests,
  invalidateChatGPTWebBrowserSession,
  resetBrowserSessionRegistryForTests,
  rotateChatGPTWebBrowserSession,
  warmChatGPTWebSentinelAfterBind,
} from './browserSession.core';
export {
  commitStagedChatGPTWebBrowserSession,
  isChatGPTWebBrowserSessionFenceCurrent,
  peekChatGPTWebBrowserSessionFence,
  stageChatGPTWebBrowserSession,
  type StagedChatGPTWebBrowserSession,
} from './browserSession.staged';
