/**
 * Latest persona document for execAgent memory injection.
 *
 * Invalidation is TTL-only (15s). Persona edits from the memory extractor or
 * the user become visible within that window; there is no write-path hook.
 * Memory module off ⇒ this helper returns null and never loads UserPersonaModel.
 */
import type { UserPersonaModel } from '@/database/models/userMemory/persona';
import type { LobeChatDatabase } from '@/database/type';

import { isModuleEnabled } from '../moduleSettings';

const TTL_MS = 15_000;
const MAX_ENTRIES = 256;

type PersonaDocument = Awaited<ReturnType<UserPersonaModel['getLatestPersonaDocument']>>;

interface PersonaResolvedSlot {
  expiresAt: number;
  value: PersonaDocument | null;
}

/** Resolved hits only — LRU-capped. In-flight promises live in `inflight`. */
const resolved = new Map<string, PersonaResolvedSlot>();
/** Uncapped: never evict a promise that a caller is still awaiting. */
const inflight = new Map<string, Promise<PersonaDocument | null>>();

let maxEntries = MAX_ENTRIES;

const slotKey = (userId: string, profile: string) => `${userId}\0${profile}`;

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

export const resetPersonaReadMemoForTest = (opts?: { maxEntries?: number }) => {
  resolved.clear();
  inflight.clear();
  maxEntries = opts?.maxEntries ?? MAX_ENTRIES;
};

export const getLatestPersonaDocumentMemo = async (params: {
  db: LobeChatDatabase;
  profile?: string;
  userId: string;
}): Promise<PersonaDocument | null> => {
  const memoryOn = await isModuleEnabled('memory').catch(() => true);
  if (!memoryOn) return null;

  const profile = params.profile ?? 'default';
  const key = slotKey(params.userId, profile);
  const now = Date.now();
  const hit = resolved.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;

  const flight = (async () => {
    const { UserPersonaModel } = await import('@/database/models/userMemory/persona');
    const doc = await new UserPersonaModel(params.db, params.userId).getLatestPersonaDocument(
      profile,
    );
    return doc ?? null;
  })();

  inflight.set(key, flight);

  try {
    const value = await flight;
    resolved.delete(key);
    resolved.set(key, { expiresAt: Date.now() + TTL_MS, value });
    evictResolved(Date.now());
    return value;
  } finally {
    if (inflight.get(key) === flight) inflight.delete(key);
  }
};
