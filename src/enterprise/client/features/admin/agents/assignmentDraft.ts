import { PLATFORM_AGENT_GLOBAL_TARGET_ID } from '@lobechat/types';

import type {
  AdminPlatformAgentAssignmentListOutput,
  AdminPlatformAgentAssignmentUpsertInput,
} from './types';

export type AssignmentTargetType = AdminPlatformAgentAssignmentUpsertInput['targetType'];
export type AssignmentMode = AdminPlatformAgentAssignmentUpsertInput['mode'];
export type Assignment = AdminPlatformAgentAssignmentListOutput['items'][number];

/** What the operator actually authors. Version policy is not one of them — see below. */
export interface AssignmentDraftFields {
  enabled: boolean;
  mode: AssignmentMode;
  targetId: string;
  targetType: AssignmentTargetType;
}

/**
 * The single normalized draft consumed by BOTH preview and the upsert mutation (parity).
 *
 * Versions are no longer a concept in the admin UI: every assignment follows the published
 * pointer, so `versionPolicy` is pinned to `latest_published` here and `pinnedVersionId` stays
 * null — which is exactly what the DB's `..._version_policy_check` requires.
 */
export type AssignmentVersionPolicy = 'latest_published' | 'pinned';

export interface NormalizedAssignmentDraft extends AssignmentDraftFields {
  pinnedVersionId: null;
  versionPolicy: 'latest_published';
}

export const normalizeAssignmentDraft = (
  fields: AssignmentDraftFields,
): NormalizedAssignmentDraft => ({
  enabled: fields.enabled,
  mode: fields.mode,
  pinnedVersionId: null,
  targetId:
    fields.targetType === 'global' ? PLATFORM_AGENT_GLOBAL_TARGET_ID : fields.targetId.trim(),
  targetType: fields.targetType,
  versionPolicy: 'latest_published',
});

/** An i18n key when the draft is not writable yet, or null when it is. */
export const validateAssignmentDraft = (draft: NormalizedAssignmentDraft): string | null => {
  if (draft.targetType !== 'global' && !draft.targetId)
    return 'agentCatalog.assignment.errors.targetRequired';
  return null;
};

/**
 * Stable fingerprint of an assignment, used to detect an actual change. `versionPolicy` and
 * `pinnedVersionId` are part of it ON PURPOSE: a legacy `pinned` row loaded from the server must
 * read as different from the `latest_published` row the editor will write, so the plan schedules
 * the upsert that un-pins it instead of quietly leaving a pin the UI no longer shows.
 */
export const assignmentDraftFingerprint = (draft: {
  enabled: boolean;
  mode: AssignmentMode;
  pinnedVersionId: string | null;
  targetId: string;
  targetType: AssignmentTargetType;
  versionPolicy: AssignmentVersionPolicy;
}): string =>
  JSON.stringify([
    draft.targetType,
    draft.targetId,
    draft.mode,
    draft.enabled,
    draft.versionPolicy,
    draft.pinnedVersionId,
  ]);

/**
 * Identity of an assignment as the DB sees it: `platform_agent_assignments_agent_target_unique`
 * is `(agent_id, target_type, target_id)`, so two drafts sharing this key are the SAME row.
 */
export const assignmentTargetKey = (draft: {
  targetId: string;
  targetType: AssignmentTargetType;
}): string => `${draft.targetType}:${draft.targetId}`;

/**
 * One row in the modal. `id` is null until the server has written it.
 *
 * The version policy is widened here (not pinned to `latest_published` like the draft) so the
 * BASELINE can carry what the server really holds — including a legacy `pinned` row created before
 * the policy left the UI. Edited entries are always normalized, so such a row shows up as a pending
 * change and is un-pinned by the next save.
 */
export interface AssignmentEntry extends AssignmentDraftFields {
  id: string | null;
  pinnedVersionId: string | null;
  versionPolicy: AssignmentVersionPolicy;
}

/** The server row exactly as it is — the comparison baseline, never a write payload. */
export const toAssignmentBaselineEntry = (assignment: Assignment): AssignmentEntry => ({
  enabled: assignment.enabled,
  id: assignment.id,
  mode: assignment.mode,
  pinnedVersionId: assignment.pinnedVersionId,
  targetId: assignment.targetId,
  targetType: assignment.targetType,
  versionPolicy: assignment.versionPolicy,
});

/** The editable projection of a server row: always `latest_published`, never pinned. */
export const toAssignmentEntry = (assignment: Assignment): AssignmentEntry => ({
  ...normalizeAssignmentDraft({
    enabled: assignment.enabled,
    mode: assignment.mode,
    targetId: assignment.targetId,
    targetType: assignment.targetType,
  }),
  id: assignment.id,
});

export interface AssignmentPlan {
  removals: string[];
  upserts: AssignmentEntry[];
}

/**
 * What has to be written to turn `baseline` (the server's assignments) into `entries`.
 * Removals come first so a target that was dropped and re-added in the same submit cannot
 * collide with the unique `(agent, target)` index.
 */
export const planAssignmentWrites = (
  baseline: readonly AssignmentEntry[],
  entries: readonly AssignmentEntry[],
): AssignmentPlan => {
  const keptIds = new Set(entries.map(({ id }) => id).filter(Boolean));
  const byId = new Map(baseline.filter(({ id }) => id).map((entry) => [entry.id!, entry]));
  return {
    removals: baseline
      .map(({ id }) => id)
      .filter((id): id is string => Boolean(id) && !keptIds.has(id)),
    upserts: entries.filter((entry) => {
      if (!entry.id) return true;
      const previous = byId.get(entry.id);
      return (
        !previous || assignmentDraftFingerprint(previous) !== assignmentDraftFingerprint(entry)
      );
    }),
  };
};

export const hasAssignmentChanges = (plan: AssignmentPlan): boolean =>
  plan.removals.length > 0 || plan.upserts.length > 0;
