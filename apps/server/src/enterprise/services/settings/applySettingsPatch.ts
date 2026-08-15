/**
 * `admin.settings.applyImmediate` body — the path→value patch surface used by the AI
 * settings forms (service-model defaults). Extracted from `adminSettingsService.ts` to
 * keep that file reviewable; behaviour is unchanged.
 */

import type { SettingsDraftPolicyMap } from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import {
  PLATFORM_SETTINGS_RESOURCE_ID,
  PLATFORM_SETTINGS_RESOURCE_TYPE,
  type SettingPolicyMode,
  type SettingPolicyVisibility,
} from '@/types/platform/settings';

import type { AppendPlatformAuditLogParams, PlatformAuditLogItem } from '../platformAudit';
import { PlatformRevisionConflictError } from '../platformPublisher';
import { collectDirtyDraftPaths } from './draftValidation';
import { SettingsDirtyDraftError, SettingsDraftValidationError } from './errors';
import { settingsRegistry } from './registry';

/** The slice of `AdminSettingsService` this body needs. */
export interface ApplySettingsPatchDeps {
  appendAudit: (
    db: LobeChatDatabase | Transaction,
    params: AppendPlatformAuditLogParams,
  ) => Promise<PlatformAuditLogItem>;
  db: LobeChatDatabase;
  getDraft: () => Promise<{
    baseRevision: number;
    draft: SettingsDraftPolicyMap;
    draftToken: string;
    publishedPolicies: SettingsDraftPolicyMap;
  }>;
  publish: (params: {
    actorUserId: string;
    expectedDraftToken: string;
    expectedRevision: number;
    reason: string;
  }) => Promise<{ auditId: string; revision: number }>;
  saveDraft: (params: {
    actorUserId: string;
    draft: SettingsDraftPolicyMap;
    expectedDraftToken: string;
    reason: string;
  }) => Promise<{ baseRevision: number; draftToken: string }>;
}

/**
 * Merge a path→value patch into the draft and publish immediately (W10-C).
 *
 * Mode rules (basis = **published** policy, not draft):
 * - published mode === 'locked' → stay 'locked'
 * - published mode === 'user' / missing → 'default'
 * - published mode === 'default' → stay 'default'
 * Visibility comes from published (fallback draft/visible). schemaVersion from registry.
 *
 * Rejects when the draft differs from published on any path outside the patch.
 *
 * On publish failure, restore uses `saved.draftToken` (not a fresh getDraft token)
 * so concurrent drafts are not overwritten; token mismatch abandons restore.
 */
export const applySettingsPatch = async (
  deps: ApplySettingsPatchDeps,
  params: { actorUserId: string; patch: Record<string, unknown>; reason?: string },
) => {
  const patchPaths = Object.keys(params.patch);
  if (patchPaths.length === 0) {
    throw new SettingsDraftValidationError([
      {
        code: 'MANAGED_SETTING_INVALID_VALUE',
        message: 'patch must include at least one path',
        path: '',
      },
    ]);
  }

  const sortedPaths = [...patchPaths].sort();
  const reason =
    params.reason?.trim() ||
    `applyImmediate: ${sortedPaths.slice(0, 12).join(', ')}${sortedPaths.length > 12 ? ` (+${sortedPaths.length - 12})` : ''}`;

  const snapshot = await deps.getDraft();
  const draft = { ...snapshot.draft } as SettingsDraftPolicyMap;
  const published = { ...snapshot.publishedPolicies } as SettingsDraftPolicyMap;

  // Dirty-draft gate: non-patch paths must match published.
  const dirtyPaths = collectDirtyDraftPaths({ draft, exemptPaths: patchPaths, published });
  if (dirtyPaths.length > 0) {
    await deps.appendAudit(deps.db, {
      action: 'admin.settings.applyImmediate',
      actorUserId: params.actorUserId,
      afterDiff: { dirtyPathCount: dirtyPaths.length },
      beforeDiff: null,
      reason,
      result: 'failure',
      targetId: PLATFORM_SETTINGS_RESOURCE_ID,
      targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
    });
    throw new SettingsDirtyDraftError(dirtyPaths);
  }

  // Start from draft (equals published outside patch when clean). Ensure published
  // paths remain present so publish does not wipe non-patched policies.
  const nextDraft: SettingsDraftPolicyMap = { ...published, ...draft };

  for (const path of patchPaths) {
    const gate = settingsRegistry.assertPathWritable({ path, requirePlatformEligible: true });
    if (gate) throw new SettingsDraftValidationError([{ code: gate, message: gate, path }]);

    const entry = settingsRegistry.get(path);
    if (!entry) {
      throw new SettingsDraftValidationError([
        { code: 'MANAGED_SETTING_UNKNOWN_PATH', message: 'Unknown path', path },
      ]);
    }

    const validated = settingsRegistry.validateValue(path, params.patch[path]);
    if (!validated.ok) {
      throw new SettingsDraftValidationError([
        { code: 'MANAGED_SETTING_INVALID_VALUE', message: validated.message, path },
      ]);
    }

    // Mode / visibility basis = published policy (ignore unpublished draft mode edits).
    const publishedPolicy = published[path];
    const draftPolicy = draft[path];
    const nextMode: SettingPolicyMode = publishedPolicy?.mode === 'locked' ? 'locked' : 'default';
    const nextVisibility = (publishedPolicy?.visibility ??
      draftPolicy?.visibility ??
      'visible') as SettingPolicyVisibility;

    nextDraft[path] = {
      mode: nextMode,
      schemaVersion: entry.schemaVersion,
      value: validated.value,
      visibility: nextVisibility,
    };
  }

  const priorDraft = { ...draft } as SettingsDraftPolicyMap;

  const saved = await deps.saveDraft({
    actorUserId: params.actorUserId,
    draft: nextDraft,
    expectedDraftToken: snapshot.draftToken,
    reason,
  });

  let publishedResult: { auditId: string; revision: number };
  try {
    publishedResult = await deps.publish({
      actorUserId: params.actorUserId,
      expectedDraftToken: saved.draftToken,
      expectedRevision: saved.baseRevision,
      reason,
    });
  } catch (error) {
    // Best-effort restore: pin expectedDraftToken to *our* saveDraft result so a
    // concurrent admin who saved during the publish-failure window is not overwritten.
    try {
      await deps.saveDraft({
        actorUserId: params.actorUserId,
        draft: priorDraft,
        expectedDraftToken: saved.draftToken,
        reason: `${reason} (restore after publish failure)`,
      });
    } catch (restoreError) {
      const abandoned =
        restoreError instanceof PlatformRevisionConflictError
          ? 'concurrent_draft_write'
          : 'restore_failed';
      try {
        await deps.appendAudit(deps.db, {
          action: 'admin.settings.applyImmediate',
          actorUserId: params.actorUserId,
          afterDiff: { abandonedRestore: abandoned },
          beforeDiff: null,
          reason: `${reason} (restore abandoned: ${abandoned})`,
          result: 'failure',
          targetId: PLATFORM_SETTINGS_RESOURCE_ID,
          targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
        });
      } catch {
        /* best-effort */
      }
    }
    throw error;
  }

  // Dedicated success audit for the combined applyImmediate operation.
  let applyAuditId = publishedResult.auditId;
  try {
    const audit = await deps.appendAudit(deps.db, {
      action: 'admin.settings.applyImmediate',
      actorUserId: params.actorUserId,
      afterDiff: {
        pathCount: sortedPaths.length,
        paths: Object.fromEntries(
          sortedPaths.map((path) => [
            path,
            { mode: nextDraft[path]?.mode, visibility: nextDraft[path]?.visibility },
          ]),
        ),
        revision: publishedResult.revision,
      },
      beforeDiff: { revision: snapshot.baseRevision },
      reason,
      result: 'success',
      targetId: PLATFORM_SETTINGS_RESOURCE_ID,
      targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
    });
    applyAuditId = audit.id;
  } catch {
    /* best-effort; publish already audited */
  }

  const after = await deps.getDraft();
  return {
    auditId: applyAuditId,
    draftToken: after.draftToken,
    paths: sortedPaths,
    revision: publishedResult.revision,
  };
};
