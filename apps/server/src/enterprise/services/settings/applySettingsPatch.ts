/**
 * `admin.settings.applyImmediate` body — the path→value patch surface used by the AI
 * settings forms (service-model defaults). Extracted from `adminSettingsService.ts` to
 * keep that file reviewable.
 *
 * This is NOT the old save-draft → publish → post-commit-audit sequence; that pipeline is
 * gone. The patch is merged into the published policy map and the whole map is handed to
 * {@link ApplySettingsPatchDeps.applyPolicies} — the single transaction shared with `save`
 * — where materialisation, draft realignment, the success audit and the revision bump all
 * commit together, or none of them do (no restore path to get wrong). The snapshot read
 * before that transaction is re-checked under its lock (revision + draft token), so a
 * concurrent settings write loses the CAS instead of publishing a stale map. Only the
 * dirty-draft rejection below audits outside the transaction, because it never opens one.
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
import { collectDirtyDraftPaths } from './draftValidation';
import { SettingsDirtyDraftError, SettingsDraftValidationError } from './errors';
import { settingsRegistry } from './registry';

/** The slice of `AdminSettingsService` this body needs. */
export interface ApplySettingsPatchDeps {
  appendAudit: (
    db: LobeChatDatabase | Transaction,
    params: AppendPlatformAuditLogParams,
  ) => Promise<PlatformAuditLogItem>;
  /** `AdminSettingsService.applyPolicies` — the transaction shared with `save`. */
  applyPolicies: (params: {
    action: 'admin.settings.applyImmediate';
    actorUserId: string;
    auditAfterDiff: (committedRevision: number) => Record<string, unknown>;
    expectedDraftToken: string;
    expectedRevision: number;
    incoming: SettingsDraftPolicyMap;
    ownership: 'full';
    reason: string;
  }) => Promise<{ auditId: string; draftToken: string; revision: number }>;
  db: LobeChatDatabase;
  getDraft: () => Promise<{
    baseRevision: number;
    draft: SettingsDraftPolicyMap;
    draftToken: string;
    publishedPolicies: SettingsDraftPolicyMap;
  }>;
}

/**
 * Merge a path→value patch into the published policy set and apply it immediately (W10-C).
 *
 * Mode rules (basis = **published** policy, not draft):
 * - published mode === 'locked' → stay 'locked'
 * - published mode === 'user' / missing → 'default'
 * - published mode === 'default' → stay 'default'
 * Visibility comes from published (fallback draft/visible). schemaVersion from registry.
 *
 * The resulting map is whole-table authoritative (`ownership: 'full'`): it always carries
 * every published path forward, so nothing outside the patch is deleted. It is applied in
 * the SAME single transaction as `save` — CAS'd on the snapshot this body read, so a
 * concurrent write makes it fail with a revision conflict and nothing is half-applied.
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

  // Dirty-draft gate: non-patch paths must match published. Every write path now aligns
  // the draft column with published inside its own transaction, so this can only fire on
  // residue left by the removed draft workflow — it stays as a fail-closed guard against
  // silently publishing someone else's stranded edits.
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
  // paths remain present so the whole-table write does not wipe non-patched policies.
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

    const rawValue = params.patch[path];
    // Null on a non-nullable schema is an explicit row delete (restore provider/model
    // default). Nullable leaves (e.g. systemAgent.*.reasoningEffort) still store null.
    if (rawValue === null && !entry.schema.safeParse(null).success) {
      delete nextDraft[path];
      continue;
    }

    const validated = settingsRegistry.validateValue(path, rawValue);
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

  // One transaction: CAS on the snapshot above, materialize, align draft, audit, commit.
  // A fault at any point rolls everything back — there is no restore path to get wrong.
  const committed = await deps.applyPolicies({
    action: 'admin.settings.applyImmediate',
    actorUserId: params.actorUserId,
    auditAfterDiff: (revision) => ({
      pathCount: sortedPaths.length,
      paths: Object.fromEntries(
        sortedPaths.map((path) => [
          path,
          { mode: nextDraft[path]?.mode, visibility: nextDraft[path]?.visibility },
        ]),
      ),
      revision,
    }),
    expectedDraftToken: snapshot.draftToken,
    expectedRevision: snapshot.baseRevision,
    incoming: nextDraft,
    ownership: 'full',
    reason,
  });

  return {
    auditId: committed.auditId,
    draftToken: committed.draftToken,
    paths: sortedPaths,
    revision: committed.revision,
  };
};
