'use client';

import { useCallback, useMemo, useState } from 'react';

import type {
  Assignment,
  AssignmentDraftFields,
  AssignmentEntry,
  AssignmentPlan,
} from './assignmentDraft';
import {
  assignmentTargetKey,
  hasAssignmentChanges,
  normalizeAssignmentDraft,
  planAssignmentWrites,
  toAssignmentBaselineEntry,
  toAssignmentEntry,
  validateAssignmentDraft,
} from './assignmentDraft';

const EMPTY_DRAFT: AssignmentDraftFields = {
  enabled: true,
  mode: 'optional',
  targetId: '',
  targetType: 'global',
};

const EMPTY_PLAN: AssignmentPlan = { removals: [], upserts: [] };

export interface UseAgentAssignmentDraftOptions {
  /**
   * The loaded assignment list did not reach the end of the collection. The editor writes a DIFF,
   * so an unseen row would read as "not present": adding its target again would hit the unique
   * (agent, target) index with no way to correct it here. Editing is therefore refused outright.
   */
  truncated?: boolean;
}

/**
 * The 分配策略 list inside the assistant editor modal.
 *
 * Nothing here talks to the server: the list is edited locally and committed by the modal's own
 * Save, so the operator sees one write boundary instead of a second, hidden one. The hook owns the
 * baseline (what the server currently holds) so a partially committed chain can resume from
 * exactly where it stopped instead of replaying writes that already landed.
 */
export const useAgentAssignmentDraft = (
  assignments: readonly Assignment[] | undefined,
  { truncated = false }: UseAgentAssignmentDraftOptions = {},
) => {
  const seed = useMemo(() => assignments ?? [], [assignments]);
  // The baseline keeps the server's RAW policy; the edited entries are normalized. A legacy
  // `pinned` row therefore reads as a pending change and the next save un-pins it.
  const [baseline, setBaseline] = useState<AssignmentEntry[]>(() =>
    seed.map(toAssignmentBaselineEntry),
  );
  const [entries, setEntries] = useState<AssignmentEntry[]>(() => seed.map(toAssignmentEntry));
  const [draft, setDraft] = useState<AssignmentDraftFields>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);

  const normalized = useMemo(() => normalizeAssignmentDraft(draft), [draft]);
  const draftError = validateAssignmentDraft(normalized);
  const plan: AssignmentPlan = useMemo(
    // A truncated list can only be read, never diffed — writing a partial diff is the bug.
    () => (truncated ? EMPTY_PLAN : planAssignmentWrites(baseline, entries)),
    [baseline, entries, truncated],
  );
  const dirty = hasAssignmentChanges(plan);

  const patchDraft = useCallback(
    <Key extends keyof AssignmentDraftFields>(key: Key, value: AssignmentDraftFields[Key]) => {
      setError(null);
      // Switching the target type invalidates whatever identifier was typed for the previous one.
      setDraft((current) =>
        key === 'targetType'
          ? { ...current, targetId: '', [key]: value }
          : { ...current, [key]: value },
      );
    },
    [],
  );

  /**
   * Adding a target that is already in the list UPDATES it in place (keeping its server id) rather
   * than creating a duplicate the unique `(agent, target)` index would reject anyway.
   */
  const add = useCallback(() => {
    if (truncated) return;
    if (draftError) {
      setError(draftError);
      return;
    }
    const key = assignmentTargetKey(normalized);
    setEntries((current) => {
      const index = current.findIndex((item) => assignmentTargetKey(item) === key);
      if (index === -1) return [...current, { ...normalized, id: null }];
      const next = [...current];
      next[index] = { ...normalized, id: current[index]!.id };
      return next;
    });
    setDraft(EMPTY_DRAFT);
    setError(null);
  }, [draftError, normalized, truncated]);

  const remove = useCallback(
    (target: AssignmentEntry) => {
      if (truncated) return;
      const key = assignmentTargetKey(target);
      setEntries((current) => current.filter((item) => assignmentTargetKey(item) !== key));
      setError(null);
    },
    [truncated],
  );

  /** A remove landed on the server — retire it from the baseline so a retry never replays it. */
  const markRemoved = useCallback((assignmentId: string) => {
    setBaseline((current) => current.filter((item) => item.id !== assignmentId));
  }, []);

  /** An upsert landed on the server — adopt its id in both the baseline and the edited list. */
  const markUpserted = useCallback((written: Assignment) => {
    const baselineEntry = toAssignmentBaselineEntry(written);
    const editable = toAssignmentEntry(written);
    const key = assignmentTargetKey(editable);
    const merge = (entry: AssignmentEntry) => (current: AssignmentEntry[]) => {
      const index = current.findIndex((item) => assignmentTargetKey(item) === key);
      if (index === -1) return [...current, entry];
      const next = [...current];
      next[index] = entry;
      return next;
    };
    setBaseline(merge(baselineEntry));
    setEntries(merge(editable));
  }, []);

  /**
   * Re-seed the baseline from an authoritative server read after an AMBIGUOUS failure (a rejected
   * transport that may still have committed). The operator's edits are kept, but any entry whose
   * target now exists on the server adopts that row's id — so a create that actually landed is
   * recognised as an update instead of being replayed into the unique index.
   */
  const reconcile = useCallback((serverAssignments: readonly Assignment[]) => {
    const idByTarget = new Map(
      serverAssignments.map((row) => [assignmentTargetKey(row), row.id] as const),
    );
    setBaseline(serverAssignments.map(toAssignmentBaselineEntry));
    setEntries((current) =>
      current.map((entry) => {
        const serverId = idByTarget.get(assignmentTargetKey(entry));
        return serverId && serverId !== entry.id ? { ...entry, id: serverId } : entry;
      }),
    );
  }, []);

  return {
    add,
    dirty,
    draft,
    draftError,
    entries,
    /** Never set while the add form is untouched — only after a rejected Add. */
    error,
    markRemoved,
    markUpserted,
    patchDraft,
    plan,
    reconcile,
    remove,
    /** The loaded list is incomplete, so this editor is read-only. */
    truncated,
  };
};

export type AgentAssignmentDraft = ReturnType<typeof useAgentAssignmentDraft>;
