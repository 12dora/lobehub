/**
 * Pure controller helpers for admin settings policy UI (testable without React).
 */

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import { canonicalize } from '../primitives/canonicalize';

export type DraftMap = AdminSettingsGetDraftOutput['draft'];
export type DraftPolicy = DraftMap[string];
export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * Admin UI collapses mode+visibility into two states:
 * - user: mode user + visibility visible (users control the setting)
 * - platform: mode locked + visibility hidden (admin value forced; user control hidden)
 * Runtime may still honor historical `default` via applyImmediate — do not strip server support.
 */
export type SettingsPolicyUiMode = 'platform' | 'user';

/** Historical default/locked → platform; user → user. */
export const toSettingsPolicyUiMode = (policy: {
  mode: string;
  visibility?: string;
}): SettingsPolicyUiMode => (policy.mode === 'user' ? 'user' : 'platform');

/** Canonical write form for the two-state UI. */
export const fromSettingsPolicyUiMode = (
  mode: SettingsPolicyUiMode,
): Pick<DraftPolicy, 'mode' | 'visibility'> =>
  mode === 'platform'
    ? { mode: 'locked', visibility: 'hidden' }
    : { mode: 'user', visibility: 'visible' };

/** Normalize every draft entry on save so legacy default/locked become locked+hidden. */
export const normalizeSettingsPolicyDraft = (draft: DraftMap): DraftMap =>
  Object.fromEntries(
    Object.entries(draft).map(([path, policy]) => {
      if (!policy) return [path, policy];
      const ui = toSettingsPolicyUiMode(policy);
      return [path, { ...policy, ...fromSettingsPolicyUiMode(ui) }];
    }),
  ) as DraftMap;

export type SettingsPermissionMode = {
  canPublish: boolean;
  canUpdate: boolean;
  canView: boolean;
};

export const deriveSettingsPermissions = (
  permissions: readonly string[],
): SettingsPermissionMode => {
  const set = new Set(permissions);
  return {
    canPublish: set.has(PLATFORM_PERMISSIONS.SETTINGS_PUBLISH),
    canUpdate: set.has(PLATFORM_PERMISSIONS.SETTINGS_UPDATE),
    canView: set.has(PLATFORM_PERMISSIONS.SETTINGS_READ),
  };
};

export type PrimaryActionKind = 'save' | 'retry' | 'publish' | 'validate' | 'none';

/**
 * Exactly one visually dominant primary action (U5-R2).
 * Publish only when draft fingerprint was successfully validated.
 * Otherwise validation is the primary when draft is clean and unvalidated.
 */
export const resolvePrimaryAction = (params: {
  canPublish: boolean;
  canUpdate: boolean;
  dirty: boolean;
  revisionConflict: boolean;
  saveState: SaveState;
  validatedForFingerprint: string | null;
  draftFingerprint: string;
}): PrimaryActionKind => {
  if (!params.canUpdate && !params.canPublish) return 'none';
  if (params.revisionConflict) return 'none';
  if (params.saveState === 'failed' && params.canUpdate) return 'retry';
  if (params.dirty && params.canUpdate) return 'save';
  if (
    !params.dirty &&
    params.canPublish &&
    params.validatedForFingerprint === params.draftFingerprint
  ) {
    return 'publish';
  }
  // Clean but not validated → validate is the one primary (not enabled publish)
  if (!params.dirty && params.canPublish) return 'validate';
  return 'none';
};

export const fingerprintDraft = (draft: DraftMap): string => {
  const keys = Object.keys(draft).sort();
  return JSON.stringify(
    keys.map((k) => {
      const p = draft[k]!;
      return [k, p.mode, p.visibility, p.schemaVersion, canonicalize(p.value)];
    }),
  );
};

export type PolicyDiffRow = {
  afterMode: string;
  afterValue: unknown;
  afterVisibility: string;
  beforeMode: string;
  beforeValue: unknown;
  beforeVisibility: string;
  changed: boolean;
  path: string;
};

export const buildChangePreview = (params: {
  draft: DraftMap;
  published: DraftMap;
  registryPaths: string[];
}): PolicyDiffRow[] => {
  const paths = new Set([...params.registryPaths, ...Object.keys(params.draft)]);
  const rows: PolicyDiffRow[] = [];
  for (const path of [...paths].sort()) {
    const d = params.draft[path];
    const p = params.published[path];
    const beforeMode = p?.mode ?? 'user';
    const afterMode = d?.mode ?? beforeMode;
    const beforeVis = p?.visibility ?? 'visible';
    const afterVis = d?.visibility ?? beforeVis;
    const beforeValue = p?.value;
    const afterValue = d?.value ?? beforeValue;
    const changed =
      beforeMode !== afterMode ||
      beforeVis !== afterVis ||
      JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
    if (!changed && !d) continue;
    rows.push({
      afterMode,
      afterValue,
      afterVisibility: afterVis,
      beforeMode,
      beforeValue,
      beforeVisibility: beforeVis,
      changed,
      path,
    });
  }
  return rows.filter((r) => r.changed);
};

/** Local draft key that survives revision advance for conflict rebase. */
export const CONFLICT_DRAFT_KEY = 'aihub.admin.settings.conflictDraft';

export type ConflictDraftPayload = {
  /** Server draft the local work was originally based on (for three-way merge). */
  originalBaseDraft: DraftMap;
  draft: DraftMap;
  previousBaseRevision: number;
  previousDraftToken: string;
  registryVersion: number;
  savedAt: string;
};

export const saveConflictDraft = (payload: ConflictDraftPayload) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONFLICT_DRAFT_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
};

export const loadConflictDraft = (): ConflictDraftPayload | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CONFLICT_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConflictDraftPayload>;
    if (
      !parsed.draft ||
      typeof parsed.previousBaseRevision !== 'number' ||
      typeof parsed.registryVersion !== 'number' ||
      typeof parsed.savedAt !== 'string'
    ) {
      return null;
    }
    return {
      draft: parsed.draft,
      originalBaseDraft: parsed.originalBaseDraft ?? {},
      previousBaseRevision: parsed.previousBaseRevision,
      previousDraftToken: parsed.previousDraftToken ?? '',
      registryVersion: parsed.registryVersion,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
};

export const clearConflictDraft = () => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(CONFLICT_DRAFT_KEY);
  } catch {
    /* ignore */
  }
};
