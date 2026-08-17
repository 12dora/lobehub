import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';

const TTL_MS = 30_000;
const MAX_ENTRIES = 256;

type UserInfo = Awaited<ReturnType<typeof UserModel.getInfoForAIGeneration>>;

interface UserInfoResolvedSlot {
  expiresAt: number;
  value: UserInfo;
}

/** Resolved hits only — LRU-capped. In-flight promises live in `inflight`. */
const resolved = new Map<string, UserInfoResolvedSlot>();
/** Uncapped: never evict a promise that a caller is still awaiting. */
const inflight = new Map<string, Promise<UserInfo>>();

let maxEntries = MAX_ENTRIES;

export const resetUserInfoReadMemoForTest = (opts?: { maxEntries?: number }) => {
  resolved.clear();
  inflight.clear();
  maxEntries = opts?.maxEntries ?? MAX_ENTRIES;
};

const evictResolved = (now: number) => {
  if (resolved.size <= maxEntries) return;
  for (const [key, slot] of resolved) {
    if (slot.expiresAt <= now) resolved.delete(key);
    if (resolved.size <= maxEntries) return;
  }
  while (resolved.size > maxEntries) {
    const oldest = resolved.keys().next().value;
    if (oldest === undefined) return;
    resolved.delete(oldest);
  }
};

/**
 * Per-user 30s memo of `UserModel.getInfoForAIGeneration` (name + language).
 * One SELECT per user per TTL instead of once per LLM step.
 */
export const getInfoForAIGenerationMemo = async (
  db: LobeChatDatabase,
  userId: string,
): Promise<UserInfo> => {
  const now = Date.now();
  const hit = resolved.get(userId);
  if (hit && hit.expiresAt > now) return hit.value;
  const pending = inflight.get(userId);
  if (pending) return pending;

  const flight = UserModel.getInfoForAIGeneration(db, userId);
  inflight.set(userId, flight);

  try {
    const value = await flight;
    resolved.delete(userId);
    resolved.set(userId, { expiresAt: Date.now() + TTL_MS, value });
    evictResolved(Date.now());
    return value;
  } finally {
    if (inflight.get(userId) === flight) inflight.delete(userId);
  }
};
