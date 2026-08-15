/** Public protocol-core types for the ChatGPT Web provider. */

export interface ChatRequirements {
  /** `OpenAI-Sentinel-Proof-Token` (may be empty) */
  proofToken: string;
  /** `OpenAI-Sentinel-SO-Token` (may be empty) */
  soToken: string;
  /** `OpenAI-Sentinel-Chat-Requirements-Token` */
  token: string;
  /** `OpenAI-Sentinel-Turnstile-Token` (may be empty) */
  turnstileToken: string;
}

export type AssetPointerKind = 'file-service' | 'sediment';

export interface Citation {
  attribution?: string;
  endIx?: number;
  groupType?: string;
  pubDate?: string;
  snippet?: string;
  startIx?: number;
  title?: string;
  url: string;
}

export interface UploadedFileRef {
  fileId: string;
  fileTokenSize?: number;
  height?: number;
  kind: 'image' | 'document';
  libraryFileId?: string;
  mimeType: string;
  name: string;
  size: number;
  width?: number;
}

/** One entry of `stream_handoff.options` (`resume_sse_endpoint`, `subscribe_ws_topic`, …). */
export interface StreamHandoffOption {
  topicId?: string;
  type?: string;
}

export type ConversationEvent =
  | { conversationId: string; type: 'conversation.start' }
  | {
      conversationId?: string;
      options?: StreamHandoffOption[];
      /** The `resume_conversation_token` JWT seen earlier on the same stream. */
      resumeToken?: string;
      turnExchangeId?: string;
      type: 'handoff';
    }
  | { delta: string; messageId?: string; text: string; type: 'text.delta' }
  | { delta: string; messageId?: string; summary?: string; type: 'reasoning.delta' }
  | { durationSec?: number; recap?: string; type: 'reasoning.done' }
  | { citations: Citation[]; type: 'citations' }
  | {
      assetPointer: string;
      fileId: string;
      messageId?: string;
      pointerKind: AssetPointerKind;
      type: 'image.pointer';
    }
  | { blocked: boolean; type: 'moderation' }
  | { modelSlug?: string; toolInvoked?: boolean; turnUseCase?: string; type: 'metadata' }
  | { endTurn?: boolean; messageId: string; status?: string; type: 'message.status' }
  | { code?: string; message: string; type: 'error' }
  | { payload: string; type: 'raw' }
  | {
      conversationId?: string;
      endTurn?: boolean;
      /**
       * The turn ended WITHOUT the upstream finishing it: the resume leg failed
       * or ran out of budget. Whatever was streamed may be a truncated prefix of
       * the answer, so the consumer must recover the rest from the conversation
       * document (and de-duplicate against what it already emitted).
       */
      recoveryRequired?: boolean;
      type: 'done';
    };

/**
 * The only values chatgpt.com accepts for `thinking_effort`. Verified live
 * 2026-08-15: `low` / `medium` / `high` are rejected with
 * `422 {"detail":"Invalid conversation body"}` on both
 * `/backend-api/conversation` and `/backend-api/f/conversation/prepare`.
 */
export type ThinkingEffort = 'standard' | 'extended' | 'max';

export interface AttachmentRef {
  fileTokenSize?: number;
  height?: number;
  id: string;
  kind: 'image' | 'document';
  libraryFileId?: string;
  mimeType: string;
  name: string;
  size: number;
  source?: 'local' | 'library';
  width?: number;
}

export interface ChatGPTWebMessage {
  attachments?: AttachmentRef[];
  content: string;
  role: 'system' | 'user' | 'assistant';
}

export interface ConversationDocumentNode {
  children?: string[];
  id?: string;
  message?: Record<string, any>;
  parent?: string;
}

export interface ConversationDocument {
  [key: string]: unknown;
  conversation_id?: string;
  current_node?: string;
  mapping?: Record<string, ConversationDocumentNode | undefined>;
  title?: string;
}
