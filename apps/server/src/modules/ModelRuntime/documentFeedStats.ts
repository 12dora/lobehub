/**
 * Per-process document-feed counters (design §6.3 / §13.7 "投喂统计").
 *
 * Kept on `globalThis` because Next.js evaluates this module once for
 * instrumentation and again per route graph; a module-level object would
 * split the counters across copies. Reset on process restart — the admin
 * status page shows `since`.
 */

export interface DocumentFeedStats {
  docsFed: number;
  imagesFed: number;
  pendingFallbacks: number;
  pendingWaits: number;
  requestsWithImages: number;
  since: string;
  toolPageViews: number;
}

const STATS_GLOBAL_KEY = Symbol.for('aihub.documentFeed.stats');
type StatsGlobal = { [STATS_GLOBAL_KEY]?: DocumentFeedStats };

const fresh = (): DocumentFeedStats => ({
  docsFed: 0,
  imagesFed: 0,
  pendingFallbacks: 0,
  pendingWaits: 0,
  requestsWithImages: 0,
  since: new Date().toISOString(),
  toolPageViews: 0,
});

const slot = (): DocumentFeedStats => {
  const global = globalThis as unknown as StatsGlobal;
  return (global[STATS_GLOBAL_KEY] ??= fresh());
};

export type DocumentFeedCounter = Exclude<keyof DocumentFeedStats, 'since'>;

export const bumpDocumentFeedStat = (counter: DocumentFeedCounter, by = 1): void => {
  const stats = slot();
  stats[counter] += Math.max(0, Math.trunc(by));
};

/** Snapshot (copy) of the counters. */
export const getDocumentFeedStats = (): DocumentFeedStats => ({ ...slot() });

/** Test-only. */
export const resetDocumentFeedStatsForTest = (): void => {
  (globalThis as unknown as StatsGlobal)[STATS_GLOBAL_KEY] = fresh();
};
