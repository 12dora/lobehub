import type { TurnRequestIdentity } from './headers';
import type { ChatGPTWebClientOptions } from './http';
import type { SentinelBundlePool } from './sentinelBundlePool';
import type { ChatRequirements } from './types';

export interface StreamConversationOptions {
  /**
   * Follow a `stream_handoff` onto `/f/conversation/resume` (default `true`).
   * Turn it off to observe the raw upstream behaviour.
   */
  autoResume?: boolean;
  conduitToken?: string;
  /** Assistant turns we replayed, so the upstream echo can be dropped. */
  echoHistory?: string[];
  hardCapMs?: number;
  idleTimeoutMs?: number;
  /** Chained resume legs allowed for this turn. */
  maxResumes?: number;
  /**
   * Fired after the first SSE leg's HTTP headers succeed (status < 300) and
   * before any ConversationEvent. Used so the runtime can return a streaming
   * Response without waiting for `conversation.start`, while still classifying
   * 401/403 at open.
   */
  onHeaders?: () => void;
  requirements: ChatRequirements;
  signal?: AbortSignal;
  /** Shared with the prepare request for this browser turn. */
  turnIdentity?: TurnRequestIdentity;
  useFPath?: boolean;
}

export interface ResumeConversationOptions {
  conversationId: string;
  echoHistory?: string[];
  hardCapMs?: number;
  idleTimeoutMs?: number;
  /** Events already consumed; `0` replays the turn from its start. */
  offset?: number;
  /** The `resume_conversation_token` JWT from the handed-off stream. */
  resumeToken: string;
  signal?: AbortSignal;
}

/**
 * Protocol client for chatgpt.com's private web API.
 *
 * All network calls go through the injected `fetch` (the server injects a
 * TLS-impersonating transport; the default `globalThis.fetch` works in tests but
 * gets Cloudflare-challenged against the real origin).
 */
export interface ChatGPTWebClientInit extends ChatGPTWebClientOptions {
  /** Test seam — production uses the process-wide pool. */
  sentinelBundlePool?: SentinelBundlePool;
}
