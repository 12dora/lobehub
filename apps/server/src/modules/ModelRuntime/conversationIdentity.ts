import { randomUUID } from 'node:crypto';

import { REQUEST_AGENT_ID_HEADER, REQUEST_TOPIC_ID_HEADER } from '@lobechat/const';
import type { TracePayload } from '@lobechat/types';

import { TopicModel } from '@/database/models/topic';
import { type LobeChatDatabase } from '@/database/type';

/**
 * ONE upstream conversation id per AIHub conversation, DERIVED — not remembered.
 *
 * The CLI-shaped runtimes (Grok, Cursor) send a session id whose UUIDv7 timestamp is
 * the moment the conversation opened. That id must be the same on every replica and
 * after every restart, so it is derived from data that outlives the process:
 *
 * - `user:<uid>:topic:<topicId>` + the topic row's `createdAt`. Both are durable, so
 *   two replicas serving two turns of one conversation derive the SAME session id.
 *   The row is read once per topic per process (single-flighted, LRU-cached): the
 *   value is immutable, so the cache can never go stale.
 * - Turn 1 of a new chat has no topic yet (LobeHub mints it server-side while the
 *   first answer streams). That turn is the ONE case with no durable identity: it
 *   uses `user:<uid>:agent:<agentId>:pending` plus the first time this process saw
 *   it. The topic-bearing turns of the same conversation therefore start a different
 *   upstream session — a one-time discontinuity per conversation, of the same kind
 *   the real CLI produces when its warm-up call runs before a session exists.
 * - Anything without either id (a headless operation) gets a fresh
 *   `user:<uid>:op:<uuid>` per runtime construction, so unrelated operations never
 *   share one upstream conversation.
 *
 * The turn index is NOT tracked here: it is the number of user messages in the
 * payload, which every replica computes identically (see `resolveTurnIndex` in the
 * Grok runtime). Truncating history can make it decrease; that is accepted, because
 * the alternative is per-process state that a restart resets anyway.
 */

const TOPIC_CREATED_AT_MAX = 4096;
/** A topic that could not be read is retried after this long instead of on every turn. */
const TOPIC_MISS_TTL_MS = 60 * 1000;
const PENDING_FIRST_SEEN_MAX = 4096;
/** A topic-less conversation of one agent is the same one for this long. */
const PENDING_FIRST_SEEN_TTL_MS = 10 * 60 * 1000;

/** Insertion-ordered Map used as an LRU: re-set on read moves the entry to the end. */
class Lru<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

interface TopicCreatedAtEntry {
  /** Set only for a miss, so an unreadable topic is retried instead of pinned forever. */
  expiresAt?: number;
  /** The in-flight (then settled) read — concurrent first turns share this one promise. */
  read: Promise<number | undefined>;
}

interface PendingFirstSeen {
  firstSeenMs: number;
  touchedAt: number;
}

const topicCreatedAtCache = new Lru<TopicCreatedAtEntry>(TOPIC_CREATED_AT_MAX);
const pendingFirstSeen = new Lru<PendingFirstSeen>(PENDING_FIRST_SEEN_MAX);

/** Test seam: drops the topic cache and the pending first-seen map. */
export const resetModelRuntimeConversationRegistry = (): void => {
  topicCreatedAtCache.clear();
  pendingFirstSeen.clear();
};

const readTopicCreatedAtMs = async (
  db: LobeChatDatabase,
  userId: string,
  topicId: string,
  workspaceId?: string,
): Promise<number | undefined> => {
  try {
    // Ownership-scoped primary-key read: a topic id belonging to another user simply
    // yields nothing and the caller falls back to the first sighting.
    const topic = await new TopicModel(db, userId, workspaceId).findById(topicId);
    const createdAt = topic?.createdAt;
    if (createdAt instanceof Date && Number.isFinite(createdAt.getTime()))
      return createdAt.getTime();
  } catch {
    // The conversation id is not worth failing a chat request over.
  }

  return undefined;
};

/**
 * One read per topic per process, shared by every concurrent first turn: the promise
 * itself is cached, so N requests arriving before the first one settles do ONE query.
 */
const readCachedTopicCreatedAtMs = async (
  db: LobeChatDatabase,
  userId: string,
  topicId: string,
  workspaceId: string | undefined,
  now: number,
): Promise<number | undefined> => {
  const cacheKey = `${userId}:${workspaceId ?? ''}:${topicId}`;
  const cached = topicCreatedAtCache.get(cacheKey);
  if (cached && (cached.expiresAt === undefined || cached.expiresAt > now)) return cached.read;

  const read = readTopicCreatedAtMs(db, userId, topicId, workspaceId);
  const entry: TopicCreatedAtEntry = { read };
  topicCreatedAtCache.set(cacheKey, entry);
  const createdAtMs = await read;
  // `createdAt` is immutable, so a hit is cached forever; a miss expires so a topic
  // that was not yet visible (or a transient DB failure) is read again later.
  if (createdAtMs === undefined) {
    topicCreatedAtCache.set(cacheKey, { ...entry, expiresAt: Date.now() + TOPIC_MISS_TTL_MS });
  }

  return createdAtMs;
};

/**
 * First sighting of a conversation that has no durable start time, kept ONLY for the
 * pre-topic phase. Bounded and TTL'd: an entry that has not been touched for
 * {@link PENDING_FIRST_SEEN_TTL_MS} belongs to a conversation that is over.
 */
const rememberFirstSeenMs = (key: string, now: number): number => {
  const known = pendingFirstSeen.get(key);
  if (known && now - known.touchedAt <= PENDING_FIRST_SEEN_TTL_MS) {
    pendingFirstSeen.set(key, { firstSeenMs: known.firstSeenMs, touchedAt: now });
    return known.firstSeenMs;
  }

  pendingFirstSeen.set(key, { firstSeenMs: now, touchedAt: now });
  return now;
};

/**
 * Start time of a conversation the CALLER identifies (an agent operation, a task run):
 * the key is durable, the start time is not, so the first sighting is remembered in
 * process — every LLM call of one operation then shares one upstream session id, and a
 * resume on another replica simply starts a new one.
 */
export const rememberModelRuntimeConversationStartMs = (
  conversationKey: string,
  now: number = Date.now(),
): number => rememberFirstSeenMs(conversationKey, now);

export interface ModelRuntimeConversationSource {
  /** Agent the request belongs to (`x-agent-id`), the only conversation-ish id at turn 1. */
  agentId?: string;
  db: LobeChatDatabase;
  topicId?: string;
  userId: string;
  workspaceId?: string;
}

export interface ModelRuntimeConversation {
  conversationKey: string;
  /** Epoch ms the conversation started — the UUIDv7 timestamp of its session id. */
  firstSeenMs: number;
}

/**
 * Resolve the conversation key and its start time for one chat request.
 *
 * Replica-stable whenever the topic exists (key and time both come from the DB); the
 * per-process fallback covers only the pre-topic turn and a topic row that cannot be
 * read (deleted, another owner, or not yet visible).
 */
export const resolveModelRuntimeConversation = async (
  source: ModelRuntimeConversationSource,
  now: number = Date.now(),
): Promise<ModelRuntimeConversation> => {
  const { agentId, db, topicId, userId, workspaceId } = source;

  if (topicId) {
    const conversationKey = `user:${userId}:topic:${topicId}`;
    const createdAtMs = await readCachedTopicCreatedAtMs(db, userId, topicId, workspaceId, now);

    return {
      conversationKey,
      firstSeenMs: createdAtMs ?? rememberFirstSeenMs(conversationKey, now),
    };
  }

  if (agentId) {
    // Turn 1: no topic exists yet, so this key cannot be re-derived later. It is
    // deliberately NOT aliased onto the topic — see the header comment.
    const conversationKey = `user:${userId}:agent:${agentId}:pending`;
    return { conversationKey, firstSeenMs: rememberFirstSeenMs(conversationKey, now) };
  }

  return { conversationKey: `user:${userId}:op:${randomUUID()}`, firstSeenMs: now };
};

/** Read the ids the SPA sends on every chat request (see `services/chat`). */
export const readConversationSourceFromRequest = (
  request: Request,
  tracePayload?: TracePayload,
): { agentId?: string; topicId?: string } => {
  const agentId =
    request.headers.get(REQUEST_AGENT_ID_HEADER)?.trim() || tracePayload?.sessionId?.trim();
  const topicId =
    tracePayload?.topicId?.trim() || request.headers.get(REQUEST_TOPIC_ID_HEADER)?.trim();

  return {
    ...(agentId ? { agentId } : {}),
    ...(topicId ? { topicId } : {}),
  };
};
