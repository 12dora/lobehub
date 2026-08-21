/**
 * Pure helpers for a ChatGPT Web chat turn: request-body description, answer
 * de-duplication, prepare-error classification, and iterator replay.
 */

import createDebug from 'debug';

import { isChatGPTWebError } from './errors';
import type {
  AttachmentRef,
  ChatGPTWebMessage,
  Citation,
  ConversationEvent,
  UploadedFileRef,
} from './types';

const log = createDebug('lobe-chatgptweb:runtime');

export const toGroundingCitation = (citation: Citation) => ({
  title: citation.title,
  url: citation.url,
});

/** Joined string parts of a conversation-document message. */
export const messageParts = (message: Record<string, any>): string => {
  const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];
  return parts.filter((part: unknown) => typeof part === 'string').join('');
};

export const toAttachmentRef = (ref: UploadedFileRef, name?: string): AttachmentRef => ({
  fileTokenSize: ref.fileTokenSize,
  height: ref.height,
  id: ref.fileId,
  kind: ref.kind,
  libraryFileId: ref.libraryFileId,
  mimeType: ref.mimeType,
  name: name ?? ref.name,
  size: ref.size,
  width: ref.width,
});

/**
 * Structural metadata about an outgoing conversation body — message count, roles
 * and switches. Deliberately NOT the body: `messages[].content.parts` is the
 * user's whole prompt (and, on the document-fallback path, whole file contents),
 * which must never reach a log line.
 */
export const describeRequestBody = (
  body: Record<string, any>,
  extra: { flow: string; model?: string; thinkingEffort?: string },
): Record<string, unknown> => {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  return {
    ...extra,
    hasAttachments: messages.some(
      (message) => (message?.metadata?.attachments as unknown[] | undefined)?.length,
    ),
    messageCount: messages.length,
    roles: messages.map((message) => message?.author?.role),
    systemHints: body?.system_hints,
    thinkingEffortSent: body?.thinking_effort,
  };
};

/**
 * The part of a recovered answer the stream has NOT already delivered.
 *
 * The chunk contract is additive — a consumer concatenates every `text` chunk
 * and cannot take one back — so a partially streamed turn whose remainder is
 * read from the conversation document must be de-duplicated here.
 */
export const undeliveredSuffix = (recovered: string, streamed: string): string => {
  if (!streamed) return recovered;
  if (recovered.startsWith(streamed)) return recovered.slice(streamed.length);
  const index = recovered.indexOf(streamed);
  if (index >= 0) return recovered.slice(index + streamed.length);
  // the document and the stream disagree: appending would show the answer twice
  log('recovered answer diverges from the streamed text; appending nothing');
  return '';
};

/** Re-yield an iterator whose first result has already been pulled. */
export async function* replayIterator<T>(
  first: IteratorResult<T>,
  iterator: AsyncIterator<T>,
): AsyncGenerator<T, void, undefined> {
  try {
    if (first.done) return;
    yield first.value;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // propagate cancellation (client abort) into the underlying SSE reader
    await iterator.return?.(undefined);
  }
}

/**
 * Same as {@link replayIterator}, but the first pull may still be in flight so
 * the runtime can return a streaming Response as soon as HTTP headers succeed.
 */
export async function* replayPendingFirst<T>(
  firstPromise: Promise<IteratorResult<T>>,
  iterator: AsyncIterator<T>,
): AsyncGenerator<T, void, undefined> {
  try {
    const first = await firstPromise;
    if (first.done) return;
    yield first.value;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.(undefined);
  }
}

export interface TurnState {
  conversationId?: string;
  /** the cleanup hook already fired — hiding twice is a wasted round trip */
  hidden?: boolean;
  /** Epoch SECONDS (the document's own unit) at which this request was sent. */
  startedAtSec?: number;
  /** The id we generated for this turn's last user message. */
  userMessageId?: string;
}

/** The id the body builder generated for the last user message of the turn. */
export const lastUserMessageId = (body: Record<string, any>): string | undefined => {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.author?.role === 'user' && typeof message.id === 'string') return message.id;
  }
  return undefined;
};

export const isAbortError = (error: unknown): boolean =>
  (error as { name?: unknown } | undefined)?.name === 'AbortError';

/**
 * Prepare failures the plain path may still be able to serve — an ALLOWLIST, so
 * a kind nobody classified here never silently degrades a turn:
 *
 * - `network` / `timeout`: the conduit endpoint (or the hop to it) hiccuped;
 * - `upstream`: an unusable 5xx / malformed prepare body (a blank conduit token
 *   included) — the legacy endpoint does not need one at all;
 * - `not_found`: this account does not have `/f/conversation/prepare`, which is
 *   exactly what the legacy endpoint is for.
 *
 * Everything else stays fatal: `auth` / `permission` / `rate_limit` are about
 * the account, `cloudflare` blocks every path equally, `model_cap` is refused by
 * the plain path too, `transport_unavailable` has no transport to retry on, a
 * caller abort is the user leaving, and an UNTYPED error is a bug of ours that
 * must surface rather than hide behind a degraded turn.
 */
const RECOVERABLE_PREPARE_KINDS = new Set(['network', 'not_found', 'timeout', 'upstream']);

export const isRecoverablePrepareError = (error: unknown): boolean =>
  !isAbortError(error) && isChatGPTWebError(error) && RECOVERABLE_PREPARE_KINDS.has(error.kind);

/**
 * 4xx on `/f/conversation` that means the send raced ahead of prepare state
 * (missing conduit token / client_prepare). Distinct from auth / Cloudflare /
 * rate-limit, which must stay fatal.
 */
const MISSING_CONDUIT_STATUSES = new Set([400, 409, 422]);
const MISSING_CONDUIT_MARKERS = [
  'conduit',
  'prepare_token',
  'client_prepare',
  'conversation_prepare',
];
const FATAL_CONDUIT_RETRY_KINDS = new Set([
  'auth',
  'cloudflare',
  'permission',
  'rate_limit',
  'model_cap',
  'transport_unavailable',
]);

export const isMissingConduitPrepareError = (error: unknown): boolean => {
  if (isAbortError(error) || !isChatGPTWebError(error)) return false;
  if (FATAL_CONDUIT_RETRY_KINDS.has(error.kind)) return false;
  const haystack =
    `${error.message} ${error.code ?? ''} ${typeof error.body === 'string' ? error.body : JSON.stringify(error.body ?? '')}`.toLowerCase();
  if (MISSING_CONDUIT_MARKERS.some((marker) => haystack.includes(marker))) return true;
  return (
    error.kind === 'upstream' &&
    typeof error.status === 'number' &&
    MISSING_CONDUIT_STATUSES.has(error.status)
  );
};

/**
 * Wait until the first SSE leg has HTTP headers (or the iterator fails). Does
 * not wait for the first ConversationEvent when `onHeaders` fires first.
 */
export const waitForStreamHeaders = async (
  headersOpened: Promise<void>,
  first: Promise<unknown>,
): Promise<void> => {
  await Promise.race([
    headersOpened,
    first.then(
      () => undefined,
      (error: unknown) => {
        throw error;
      },
    ),
  ]);
};

/** A one-shot event stream that only ever throws — used to replay a caller abort. */
// eslint-disable-next-line require-yield -- intentionally yields nothing: it exists to throw
export async function* throwingEvents(
  error: unknown,
): AsyncGenerator<ConversationEvent, void, undefined> {
  throw error;
}

export const lastUserText = (messages: ChatGPTWebMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].content;
  }
  return messages.at(-1)?.content ?? '';
};
