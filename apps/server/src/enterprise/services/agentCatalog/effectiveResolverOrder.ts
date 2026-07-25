/**
 * Pure ordering / projection helpers for the effective-agent keyset list.
 * SQL and policy stay in sibling modules so list-order changes cannot silently
 * alter authorization or mutation paths.
 */
import type { PlatformAgentVersionConfig } from '@lobechat/types';
import type { z } from 'zod';

import type { PlatformAgentEffectiveInput } from '@/database/repositories/platformAgentCatalog';

import type { platformAgentEffectiveListOutputSchema } from '../../contracts/platformAgents';

type EffectiveList = z.infer<typeof platformAgentEffectiveListOutputSchema>;
type EffectiveAgent = EffectiveList['agents'][number];
type Distribution = EffectiveAgent['distribution'];

/** Matches `platformAgentEffectiveListOutputSchema.agents.max(1000)` — never exceed the wire contract. */
export const PLATFORM_AGENT_EFFECTIVE_LIST_MAX = 1000;

/**
 * SQL page size for full-list keyset pagination over **visible winners** (post DISTINCT ON +
 * hidden filter). The resolver walks pages until {@link PLATFORM_AGENT_EFFECTIVE_LIST_MAX}
 * winners are collected or the source is exhausted. Dedup lives in SQL — no growing in-memory
 * `seen` / systemKey sets across pages.
 */
export const PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH = PLATFORM_AGENT_EFFECTIVE_LIST_MAX;

/**
 * Keyset cursor for full-list paging of **visible winners**.
 *
 * Stable list order (after SQL first-winner selection + hidden filter):
 * `assignment.created_at DESC, assignment.id DESC`.
 *
 * First-winner selection (DISTINCT ON) still uses the product priority order
 * `targetPriority DESC, agentKey ASC, assignment.id ASC` so multi-target assignments
 * keep user > global_role > global. Only the surviving winners are keyset-paged by recency.
 */
export interface PlatformAgentEffectiveInputCursor {
  createdAt: Date | string;
  id: string;
}

/**
 * Immutable, copy-safe exact-version snapshot captured at the start of one operation (R2).
 * A caller pins this value for the whole operation and never re-resolves the current pointer,
 * so publishing v2 mid-flight cannot swap the version out from under an in-progress operation.
 * The object and its `config` are deep-frozen; a caller mutation cannot pollute the resolver
 * or a later snapshot.
 */
export interface PlatformAgentOperationSnapshot {
  checksum: string;
  config: PlatformAgentVersionConfig;
  platformAgentId: string;
  versionId: string;
}

/**
 * Operation-scoped handle (R2). Wraps a single captured snapshot; `getSnapshot()` replays that
 * exact frozen value for the whole operation and never re-resolves the current pointer.
 */
export interface PlatformAgentOperationHandle {
  readonly distribution?: Distribution;
  getSnapshot: () => PlatformAgentOperationSnapshot;
  readonly platformAgentId: string;
}

/**
 * Repository surface used by the resolver. Wider than a pure Pick so keyset `cursor` is part of
 * the contract. Production full-list paging uses in-service SQL when no custom repository is
 * injected; injected repositories (tests / overrides) MUST honor cursor the same way for
 * targeted paths that still go through the repository.
 */
export type PlatformAgentEffectiveInputsFilter = {
  /** Keyset after this visible-winner row (exclusive). Full-list path only. */
  cursor?: PlatformAgentEffectiveInputCursor;
  limit?: number;
  platformAgentId?: string;
  systemKey?: string;
};

type EffectiveInputRow = PlatformAgentEffectiveInput;

/** Compare winner-list keyset order: createdAt DESC, assignment.id DESC. */
export const compareEffectiveWinnerOrder = (
  left: EffectiveInputRow,
  right: EffectiveInputRow,
): number => {
  const leftAt = toMillis(left.assignment.createdAt);
  const rightAt = toMillis(right.assignment.createdAt);
  return rightAt - leftAt || right.assignment.id.localeCompare(left.assignment.id);
};

/** Canonical first-winner priority: targetPriority DESC, agentKey ASC, assignment.id ASC. */
export const compareEffectiveInputPriority = (
  left: EffectiveInputRow,
  right: EffectiveInputRow,
): number =>
  right.targetPriority - left.targetPriority ||
  left.agent.agentKey.localeCompare(right.agent.agentKey) ||
  left.assignment.id.localeCompare(right.assignment.id);

export const cursorFromEffectiveInputRow = (
  row: EffectiveInputRow,
): PlatformAgentEffectiveInputCursor => ({
  createdAt: row.assignment.createdAt,
  id: row.assignment.id,
});

const toMillis = (value: Date | string | number): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
};

/**
 * True when `row` is strictly after `cursor` in winner list order
 * (`createdAt DESC, assignment.id DESC`).
 */
export const isEffectiveInputAfterCursor = (
  row: EffectiveInputRow,
  cursor: PlatformAgentEffectiveInputCursor,
): boolean => {
  const rowAt = toMillis(row.assignment.createdAt);
  const cursorAt = toMillis(cursor.createdAt);
  if (rowAt !== cursorAt) return rowAt < cursorAt;
  return row.assignment.id.localeCompare(cursor.id) < 0;
};

/**
 * In-memory stand-in for the production full-list SQL pipeline
 * ({@link queryVisibleWinnerPage}):
 * 1. first-winner per dedup key by priority (regardless of hidden)
 * 2. drop non-mandatory winners whose agent is hidden
 * 3. order surviving winners by createdAt DESC, id DESC
 * 4. exclusive keyset page + limit
 *
 * Used by unit tests only. Scale regressions must call the real SQL path.
 */
export const sliceEffectiveInputsByKeyset = (
  orderedRows: EffectiveInputRow[],
  filter?: Pick<PlatformAgentEffectiveInputsFilter, 'cursor' | 'limit'> & {
    hidden?: ReadonlySet<string>;
  },
): EffectiveInputRow[] => {
  const winners = projectFirstWinnersThenHide(orderedRows, filter?.hidden ?? new Set());
  winners.sort(compareEffectiveWinnerOrder);
  const limit = filter?.limit ?? winners.length;
  const cursor = filter?.cursor;
  let start = 0;
  if (cursor) {
    start = winners.findIndex((item) => isEffectiveInputAfterCursor(item, cursor));
    if (start < 0) return [];
  }
  return winners.slice(start, start + limit);
};

/**
 * First-winner per agent (and per systemKey) by priority, then drop hidden non-mandatory winners.
 * Mirrors the SQL DISTINCT ON → hidden-filter order so a lower-priority duplicate never resurfaces.
 */
export const projectFirstWinnersThenHide = (
  rows: EffectiveInputRow[],
  hidden: ReadonlySet<string>,
): EffectiveInputRow[] => {
  const byPriority = [...rows].sort(compareEffectiveInputPriority);
  const seenAgents = new Set<string>();
  const seenSystemKeys = new Set<string>();
  const winners: EffectiveInputRow[] = [];

  for (const row of byPriority) {
    if (seenAgents.has(row.agent.id)) continue;
    if (row.agent.systemKey && seenSystemKeys.has(row.agent.systemKey)) continue;
    seenAgents.add(row.agent.id);
    if (row.agent.systemKey) seenSystemKeys.add(row.agent.systemKey);

    const distribution = row.assignment.mode as Distribution;
    if (distribution !== 'mandatory' && hidden.has(row.agent.id)) {
      // Winner is hidden → whole key suppressed (do not fall through to a lower-priority row).
      continue;
    }
    winners.push(row);
  }
  return winners;
};
