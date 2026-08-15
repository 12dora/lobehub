import createDebug from 'debug';

import type { ChatGPTWebClient } from './client';
import { RETRYABLE_POLL_STATUSES } from './constants';
import { isChatGPTWebError } from './errors';
import type { ImagePointer } from './imageResolve';
import { mergePointers, pointerKindOf, samePointerSet } from './imageResolve';
import type { ConversationDocument } from './types';

const log = createDebug('lobe-chatgptweb:image-poll');

/** Poll defaults. Deliberately NOT aliased to the SSE hard cap (E3 §6, smell 1). */
export const IMAGE_POLL_DEFAULTS = {
  /**
   * Confirm SSE pointers against the conversation document before returning.
   *
   * ACCEPTED DEVIATION from K5's "settle 2s stable-set rule": off by default, so
   * a document hit returns immediately. `picture_v2` produces one asset per turn
   * and the extra round trip costs every caller ~2s for a second image that does
   * not come. The settle machinery stays available (and tested) for the callers
   * that opt in with `checkBeforeHit: true`.
   */
  checkBeforeHit: false,
  /** Generation takes ~30s; polling immediately trips a transient 429. */
  initialWaitMs: 10_000,
  intervalMs: 5000,
  /** Re-check after the first pointers appear so a 2nd asset is not truncated. */
  settle: true,
  settleMs: 2000,
} as const;

const POINTER_PATTERNS = [
  { kind: 'file-service' as const, regex: /file-service:\/\/([\w-]+)/g },
  { kind: 'sediment' as const, regex: /sediment:\/\/([\w-]+)/g },
  // bare generated-image ids appear in tool metadata without a scheme prefix
  { kind: 'file-service' as const, regex: /\bfile_0{8}[\da-f]{24}\b/g },
];

const asRecord = (value: unknown): Record<string, any> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

const walk = (value: unknown, visit: (node: Record<string, any>) => void, depth = 0): void => {
  if (depth > 12) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  visit(record);
  for (const item of Object.values(record)) walk(item, visit, depth + 1);
};

const hasImageAssetPointer = (value: unknown): boolean => {
  let found = false;
  walk(value, (node) => {
    if (found) return;
    if (node.content_type === 'image_asset_pointer') found = true;
    else if (typeof node.asset_pointer === 'string' && pointerKindOf(node.asset_pointer))
      found = true;
  });
  return found;
};

/** Recursively harvest pointer ids out of every string in a subtree. */
export const collectPointers = (value: unknown): ImagePointer[] => {
  const out: ImagePointer[] = [];
  const scan = (text: string) => {
    for (const { kind, regex } of POINTER_PATTERNS) {
      for (const match of text.matchAll(regex)) out.push({ fileId: match[1] ?? match[0], kind });
    }
  };

  const visit = (node: unknown, depth: number): void => {
    if (depth > 12) return;
    if (typeof node === 'string') return scan(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    for (const item of Object.values(record)) visit(item, depth + 1);
  };

  visit(value, 0);
  return mergePointers(out);
};

/**
 * Image pointers from a conversation document, oldest tool record first.
 * Only tool records (and assistant records that actually carry image output)
 * qualify — the user's turn echoes its uploaded references and must be ignored.
 */
export const extractDocumentPointers = (document: ConversationDocument): ImagePointer[] => {
  const records: { createTime: number; pointers: ImagePointer[] }[] = [];

  for (const node of Object.values(document?.mapping ?? {})) {
    const message = asRecord(node?.message);
    if (!message) continue;

    const role = String(asRecord(message.author)?.role ?? '').toLowerCase();
    if (role !== 'tool' && role !== 'assistant') continue;

    const metadata = asRecord(message.metadata);
    const isImageGen = metadata?.async_task_type === 'image_gen';
    const hasPointer =
      hasImageAssetPointer(message.content) || (metadata && hasImageAssetPointer(metadata));
    if (role === 'assistant' && !isImageGen && !hasPointer) continue;

    const pointers = mergePointers(collectPointers(message.content), collectPointers(metadata));
    if (pointers.length === 0) continue;

    records.push({ createTime: Number(message.create_time) || 0, pointers });
  }

  records.sort((left, right) => left.createTime - right.createTime);
  return mergePointers(...records.map((record) => record.pointers));
};

/**
 * Structural task-failure check — `/backend-api/tasks` is the only trustworthy
 * policy signal. Never classify by matching words in the assistant's prose
 * (E3 §6, smell 3).
 */
export const findTaskErrorMessage = (tasks: unknown[]): string | undefined => {
  for (const task of tasks) {
    const message = asRecord(asRecord(task)?.image_gen_message);
    if (!message) continue;
    if (asRecord(message.metadata)?.is_error !== true) continue;

    const content = asRecord(message.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const text = parts.filter((part: unknown) => typeof part === 'string').join('');
    return text || 'the upstream image task reported an error';
  }
  return undefined;
};

const sleep = (ms: number) =>
  ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `Retry-After: 0` means "retry now" and must survive a falsy check. */
export const retryDelayMs = (attempt: number, retryAfterMs: number | undefined): number => {
  const base =
    retryAfterMs === undefined ? Math.min(2 ** Math.min(attempt, 4), 16) * 1000 : retryAfterMs;
  return base + Math.round(Math.random() * 500);
};

export interface PollImageOptions {
  checkBeforeHit?: boolean;
  client: ChatGPTWebClient;
  conversationId: string;
  /** Absolute wall-clock budget shared by the whole `createImage` call. */
  deadline: number;
  initialPointers?: ImagePointer[];
  initialWaitMs?: number;
  intervalMs?: number;
  settle?: boolean;
  settleMs?: number;
  signal?: AbortSignal;
}

export interface PollImageResult {
  pointers: ImagePointer[];
  taskErrorMessage?: string;
  timedOut: boolean;
}

/**
 * Poll the conversation document until image pointers appear (or the shared
 * deadline runs out). Returns rather than throws on timeout — the caller decides
 * whether partial pointers are still worth resolving.
 */
export const pollImageResults = async ({
  checkBeforeHit = IMAGE_POLL_DEFAULTS.checkBeforeHit,
  client,
  conversationId,
  deadline,
  initialPointers = [],
  initialWaitMs = IMAGE_POLL_DEFAULTS.initialWaitMs,
  intervalMs = IMAGE_POLL_DEFAULTS.intervalMs,
  settle = IMAGE_POLL_DEFAULTS.settle,
  settleMs = IMAGE_POLL_DEFAULTS.settleMs,
  signal,
}: PollImageOptions): Promise<PollImageResult> => {
  const remaining = () => deadline - Date.now();

  let pointers = mergePointers(initialPointers);
  let lastHit: ImagePointer[] | undefined = pointers.length > 0 ? pointers : undefined;
  let taskErrorMessage: string | undefined;
  let attempt = 0;

  // A long initial wait must never eat the entire budget (E3 §6, smell 15).
  const firstWait =
    pointers.length > 0 && settle
      ? Math.min(settleMs, remaining())
      : Math.min(initialWaitMs, remaining() * 0.25);
  await sleep(firstWait);

  while (remaining() > 0) {
    // The task list is unfiltered and large; only consult it while we have
    // nothing, which is the only case where its error text matters.
    if (pointers.length === 0 && attempt % 3 === 0) {
      try {
        taskErrorMessage = findTaskErrorMessage(await client.listTasks(conversationId, signal));
      } catch (error) {
        log('task query failed: %s', String(error));
      }
    }

    let document: ConversationDocument;
    try {
      document = await client.getConversation(conversationId, signal);
    } catch (error) {
      const retryable =
        isChatGPTWebError(error) &&
        (RETRYABLE_POLL_STATUSES.has(error.status ?? 0) ||
          error.kind === 'network' ||
          error.kind === 'timeout');
      if (!retryable) throw error;

      attempt += 1;
      const retryAfter = isChatGPTWebError(error) ? error.retryAfterMs : undefined;
      await sleep(Math.min(retryDelayMs(attempt, retryAfter), remaining()));
      continue;
    }

    attempt += 1;
    const next = mergePointers(pointers, extractDocumentPointers(document));
    pointers = next;

    if (next.length > 0) {
      if (!checkBeforeHit) return { pointers: next, timedOut: false };
      if (lastHit && samePointerSet(lastHit, next)) return { pointers: next, timedOut: false };
      lastHit = next;
      if (!settle) return { pointers: next, timedOut: false };
      await sleep(Math.min(settleMs, remaining()));
      continue;
    }

    await sleep(Math.min(intervalMs, remaining()));
  }

  return { pointers, taskErrorMessage, timedOut: true };
};
