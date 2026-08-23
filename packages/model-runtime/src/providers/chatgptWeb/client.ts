import { assertAllowedAssetUrl } from './assetUrls';
import { abortableSleep, MAX_DOWNLOAD_BYTES, readBoundedBody } from './boundedBody';
import { ChatGPTWebFileClient } from './fileClient';

export type {
  ChatGPTWebClientInit,
  ResumeConversationOptions,
  StreamConversationOptions,
} from './clientTypes';

/**
 * Protocol client for chatgpt.com's private web API.
 *
 * All network calls go through the injected `fetch` (the server injects a
 * TLS-impersonating transport; the default `globalThis.fetch` works in tests but
 * gets Cloudflare-challenged against the real origin).
 */
export class ChatGPTWebClient extends ChatGPTWebFileClient {}

export { abortableSleep, assertAllowedAssetUrl, MAX_DOWNLOAD_BYTES, readBoundedBody };
export { isAllowedAssetUrl } from './assetUrls';
export type { ChatGPTWebBootstrapState, ChatGPTWebSessionContext } from './sessionContext';
export { createMemoryChatGPTWebSessionContext } from './sessionContext';

// The protocol core's public surface. `index.ts` is intentionally left to the
// runtime layer (`LobeChatGPTWebAI`), so consumers import from here.
export * from './binary';
export * from './citations';
export * from './constants';
export * from './errors';
export * from './headers';
export * from './http';
export * from './pow';
export * from './requestBuilders';
export * from './sentinel';
export * from './sentinelBundlePool';
export * from './sse/annotations';
export * from './sse/bento';
export * from './sse/events';
export * from './sse/patch';
export * from './sse/reader';
export * from './turnstile';
export * from './types';
