/**
 * In-memory per-turn call budget for `viewDocumentPages`.
 *
 * Stored on `globalThis` via `Symbol.for` so Next.js module copies (instrumentation
 * vs route graph) share one counter. Entries expire after `ttlMs` so a crashed
 * turn cannot pin the key forever.
 */

export const DOCUMENT_PAGES_CALL_LIMIT = 3;

/** Budget keys last 15 minutes so a multi-round user turn still shares one counter. */
export const DOCUMENT_PAGES_CALL_BUDGET_TTL_MS = 15 * 60 * 1000;

/** Hard cap on in-memory keys; oldest entries are evicted first. */
export const DOCUMENT_PAGES_CALL_BUDGET_MAX_ENTRIES = 10_000;

export const DOCUMENT_PAGES_TURN_LIMIT_MESSAGE =
  'viewDocumentPages limit reached for this turn (3). Name the page numbers in your reply; they will be attached next turn.';

const BUDGET_GLOBAL_KEY = Symbol.for('aihub.documentPages.callBudget');

interface BudgetEntry {
  count: number;
  expiresAt: number;
}

type BudgetGlobal = { [BUDGET_GLOBAL_KEY]?: Map<string, BudgetEntry> };

const store = (): Map<string, BudgetEntry> => {
  const global = globalThis as unknown as BudgetGlobal;
  return (global[BUDGET_GLOBAL_KEY] ??= new Map());
};

const prune = (now: number) => {
  const entries = store();
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
};

const evictOldest = () => {
  const entries = store();
  while (entries.size >= DOCUMENT_PAGES_CALL_BUDGET_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
};

export interface DocumentPagesCallBudget {
  consume: (key: string) => { allowed: boolean; used: number };
}

export const createDocumentPagesCallBudget = ({
  limit,
  ttlMs,
}: {
  limit: number;
  ttlMs: number;
}): DocumentPagesCallBudget => ({
  consume: (key) => {
    const now = Date.now();
    prune(now);
    const entries = store();
    const existing = entries.get(key);
    if (!existing || existing.expiresAt <= now) {
      evictOldest();
      entries.set(key, { count: 1, expiresAt: now + ttlMs });
      return { allowed: true, used: 1 };
    }
    existing.count += 1;
    return { allowed: existing.count <= limit, used: existing.count };
  },
});

/** Test-only. */
export const resetDocumentPagesCallBudgetForTest = (): void => {
  (globalThis as unknown as BudgetGlobal)[BUDGET_GLOBAL_KEY] = new Map();
};
