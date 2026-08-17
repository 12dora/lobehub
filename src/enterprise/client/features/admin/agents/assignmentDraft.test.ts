import { PLATFORM_AGENT_GLOBAL_TARGET_ID } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import type { AssignmentEntry } from './assignmentDraft';
import {
  assignmentDraftFingerprint,
  assignmentTargetKey,
  hasAssignmentChanges,
  normalizeAssignmentDraft,
  planAssignmentWrites,
  toAssignmentBaselineEntry,
  toAssignmentEntry,
  validateAssignmentDraft,
} from './assignmentDraft';

const entry = (over: Partial<AssignmentEntry> = {}): AssignmentEntry => ({
  ...normalizeAssignmentDraft({
    enabled: true,
    mode: 'optional',
    targetId: 'user-1',
    targetType: 'user',
  }),
  id: 'assignment-1',
  ...over,
});

describe('assignment draft normalization + validation', () => {
  it('normalizes a global target to the sentinel and never pins a version', () => {
    const draft = normalizeAssignmentDraft({
      enabled: true,
      mode: 'optional',
      targetId: 'ignored',
      targetType: 'global',
    });
    expect(draft).toEqual({
      enabled: true,
      mode: 'optional',
      pinnedVersionId: null,
      targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID,
      targetType: 'global',
      versionPolicy: 'latest_published',
    });
    expect(validateAssignmentDraft(draft)).toBeNull();
  });

  it('trims a non-global target id', () => {
    const draft = normalizeAssignmentDraft({
      enabled: false,
      mode: 'mandatory',
      targetId: '  role-admins  ',
      targetType: 'global_role',
    });
    expect(draft.targetId).toBe('role-admins');
    expect(draft.pinnedVersionId).toBeNull();
    expect(validateAssignmentDraft(draft)).toBeNull();
  });

  it('flags a missing target id', () => {
    expect(
      validateAssignmentDraft(
        normalizeAssignmentDraft({
          enabled: true,
          mode: 'optional',
          targetId: '   ',
          targetType: 'user',
        }),
      ),
    ).toBe('agentCatalog.assignment.errors.targetRequired');
  });

  it('keys a draft by the exact tuple the unique index uses', () => {
    expect(
      assignmentTargetKey(
        normalizeAssignmentDraft({
          enabled: true,
          mode: 'optional',
          targetId: ' user-1 ',
          targetType: 'user',
        }),
      ),
    ).toBe('user:user-1');
    // Mode and enabled are NOT part of identity — the same target is the same row.
    expect(assignmentDraftFingerprint(entry())).not.toBe(
      assignmentDraftFingerprint(entry({ mode: 'mandatory' })),
    );
  });

  it('keeps the RAW policy on a baseline entry so a legacy pin reads as a pending change', () => {
    const raw = {
      agentId: 'agent-1',
      enabled: true,
      id: 'assignment-9',
      mode: 'default',
      pinnedVersionId: 'version-3',
      targetId: 'user-9',
      targetType: 'user',
      versionPolicy: 'pinned',
    } as never;
    expect(toAssignmentBaselineEntry(raw)).toMatchObject({
      pinnedVersionId: 'version-3',
      versionPolicy: 'pinned',
    });
    // The baseline and the editable projection differ, which is exactly what schedules the un-pin.
    expect(assignmentDraftFingerprint(toAssignmentBaselineEntry(raw))).not.toBe(
      assignmentDraftFingerprint(toAssignmentEntry(raw)),
    );
    expect(
      planAssignmentWrites([toAssignmentBaselineEntry(raw)], [toAssignmentEntry(raw)]),
    ).toEqual({
      removals: [],
      upserts: [expect.objectContaining({ id: 'assignment-9', versionPolicy: 'latest_published' })],
    });
  });

  it('maps a server assignment onto an editable entry, dropping any legacy pin', () => {
    expect(
      toAssignmentEntry({
        agentId: 'agent-1',
        enabled: true,
        id: 'assignment-9',
        mode: 'default',
        pinnedVersionId: 'version-3',
        targetId: 'user-9',
        targetType: 'user',
        versionPolicy: 'pinned',
      } as never),
    ).toEqual({
      enabled: true,
      id: 'assignment-9',
      mode: 'default',
      pinnedVersionId: null,
      targetId: 'user-9',
      targetType: 'user',
      versionPolicy: 'latest_published',
    });
  });
});

describe('planAssignmentWrites', () => {
  it('reports nothing to write when the list is untouched', () => {
    const baseline = [entry()];
    const plan = planAssignmentWrites(baseline, [entry()]);
    expect(plan).toEqual({ removals: [], upserts: [] });
    expect(hasAssignmentChanges(plan)).toBe(false);
  });

  it('writes only the entries that changed, and removes the ones that are gone', () => {
    const baseline = [entry(), entry({ id: 'assignment-2', targetId: 'user-2' })];
    const plan = planAssignmentWrites(baseline, [
      entry({ mode: 'mandatory' }),
      entry({ id: null, targetId: 'user-3' }),
    ]);
    expect(plan.removals).toEqual(['assignment-2']);
    expect(plan.upserts.map(({ id, mode, targetId }) => ({ id, mode, targetId }))).toEqual([
      { id: 'assignment-1', mode: 'mandatory', targetId: 'user-1' },
      { id: null, mode: 'optional', targetId: 'user-3' },
    ]);
    expect(hasAssignmentChanges(plan)).toBe(true);
  });

  it('treats a dropped-and-re-added target as a removal plus a fresh create', () => {
    const plan = planAssignmentWrites([entry()], [entry({ id: null })]);
    expect(plan.removals).toEqual(['assignment-1']);
    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]!.id).toBeNull();
  });
});
