import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { SkillManifest, SkillResource } from '@/server/enterprise/contracts/skillCatalog';
import {
  skillManifestSchema,
  skillResourceSchema,
} from '@/server/enterprise/contracts/skillCatalog';

import type {
  AdminSkillCreateVersionInput,
  AdminSkillGetOutput,
  AdminSkillParseImportSourceOutput,
  AdminSkillUpdateDraftInput,
  AdminSkillValidateOutput,
} from './types';

export type SkillSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';

export interface SkillPermissions {
  canArchive: boolean;
  canCreate: boolean;
  canPublish: boolean;
  canRead: boolean;
  canUpdate: boolean;
}

export const deriveSkillPermissions = (permissions: readonly string[]): SkillPermissions => {
  const granted = new Set(permissions);
  return {
    canArchive: granted.has(PLATFORM_PERMISSIONS.SKILL_DELETE),
    canCreate: granted.has(PLATFORM_PERMISSIONS.SKILL_CREATE),
    canPublish: granted.has(PLATFORM_PERMISSIONS.SKILL_PUBLISH),
    canRead: granted.has(PLATFORM_PERMISSIONS.SKILL_READ),
    canUpdate: granted.has(PLATFORM_PERMISSIONS.SKILL_UPDATE),
  };
};

export interface EditableSkillIdentityDraft {
  description: string;
  displayName: string;
  distribution: 'default' | 'mandatory' | 'optional';
  enabled: boolean;
}

export interface EditableSkillVersionDraft {
  content: string;
  contentRef: string;
  manifestText: string;
  resourcesText: string;
  version: string;
}

export interface EditableSkillDraft {
  identity: EditableSkillIdentityDraft;
  versionDraft: EditableSkillVersionDraft | null;
}

export interface SkillRebaseConflict {
  field: keyof EditableSkillIdentityDraft;
  latest: EditableSkillIdentityDraft[keyof EditableSkillIdentityDraft];
  local: EditableSkillIdentityDraft[keyof EditableSkillIdentityDraft];
}

export const toEditableSkillDraft = (snapshot: AdminSkillGetOutput): EditableSkillDraft => ({
  identity: {
    description: snapshot.draft.description ?? '',
    displayName: snapshot.draft.displayName,
    distribution: snapshot.draft.distribution,
    enabled: snapshot.draft.enabled,
  },
  versionDraft: null,
});

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableValue(record[key])]),
  );
};

export const fingerprintSkillDraft = (draft: EditableSkillDraft): string =>
  JSON.stringify(stableValue(draft));

export const isSkillIdentityDirty = (
  draft: EditableSkillDraft | null,
  baseDraft: EditableSkillDraft | null,
): boolean =>
  Boolean(
    draft &&
    baseDraft &&
    JSON.stringify(stableValue(draft.identity)) !== JSON.stringify(stableValue(baseDraft.identity)),
  );

export const fingerprintSkillSnapshot = (snapshot: AdminSkillGetOutput): string =>
  JSON.stringify(
    stableValue({
      baseRevision: snapshot.baseRevision,
      draft: snapshot.draft,
      draftToken: snapshot.draftToken,
      latestVersion: snapshot.latestVersion,
      publishedVersion: snapshot.publishedVersion,
    }),
  );

export const shouldConfirmSkillHydration = (params: {
  currentHydrationKey: string | null;
  dirty: boolean;
  hasSafeRecovery: boolean;
  nextHydrationKey: string;
}): boolean =>
  Boolean(
    params.currentHydrationKey &&
    params.currentHydrationKey !== params.nextHydrationKey &&
    params.dirty &&
    !params.hasSafeRecovery,
  );

export const buildSkillUpdatePayload = (params: {
  draft: EditableSkillIdentityDraft;
  draftToken: string;
  id: string;
  reason: string;
  revision: number;
}): AdminSkillUpdateDraftInput | null => {
  const displayName = params.draft.displayName.trim();
  const reason = params.reason.trim();
  if (!displayName || !reason) return null;
  return {
    description: params.draft.description.trim() || null,
    displayName,
    distribution: params.draft.distribution,
    enabled: params.draft.enabled,
    expectedDraftToken: params.draftToken,
    expectedRevision: params.revision,
    id: params.id,
    reason,
  };
};

export interface ParsedSkillVersionDraft {
  manifest: SkillManifest | null;
  manifestError: boolean;
  resources: SkillResource[] | null;
  resourcesError: boolean;
  valid: boolean;
}

export const parseEditableSkillVersionDraft = (
  draft: EditableSkillVersionDraft,
): ParsedSkillVersionDraft => {
  const manifest = (() => {
    try {
      return skillManifestSchema.parse(JSON.parse(draft.manifestText));
    } catch {
      return null;
    }
  })();
  const resources = (() => {
    try {
      const parsed: unknown = JSON.parse(draft.resourcesText);
      return skillResourceSchema.array().max(100).parse(parsed);
    } catch {
      return null;
    }
  })();
  const manifestError = manifest === null;
  const resourcesError = resources === null;
  return {
    manifest,
    manifestError,
    resources,
    resourcesError,
    valid:
      !manifestError &&
      !resourcesError &&
      draft.content.length > 0 &&
      draft.version.trim().length > 0,
  };
};

export const buildSkillVersionPayload = (params: {
  draft: EditableSkillVersionDraft;
  draftToken: string;
  reason: string;
  revision: number;
  skillId: string;
}): AdminSkillCreateVersionInput | null => {
  const parsed = parseEditableSkillVersionDraft(params.draft);
  const reason = params.reason.trim();
  const version = params.draft.version.trim();
  if (!parsed.valid || !parsed.manifest || !parsed.resources || !reason || !version) return null;
  return {
    content: params.draft.content,
    // Managed runtime is inline-only; opaque refs are rejected at validation/publish.
    contentRef: null,
    expectedDraftToken: params.draftToken,
    expectedRevision: params.revision,
    manifest: parsed.manifest,
    reason,
    resources: parsed.resources,
    skillId: params.skillId,
    version,
  };
};

/** Minimal valid platform skill manifest for first-time builtin override materialization. */
export const buildMinimalSkillManifest = (params: {
  description?: string | null;
  displayName: string;
}): SkillManifest => ({
  description: params.description?.trim() || params.displayName,
  displayName: params.displayName,
  localizedDescriptions: {},
  localizedDisplayNames: {},
  permissions: {
    filesystem: 'none',
    network: { allowedHosts: [], enabled: false },
    tools: { allow: [] },
  },
  skillDependencies: [],
  toolDependencies: [],
});

export type ApplyImmediateVersionPayload = {
  content: string;
  contentRef: string | null;
  manifest: SkillManifest;
  resources: SkillResource[];
  version: string;
};

/**
 * Import-only conversion: requires a typed parse-import result with a required
 * enterprise manifest. Never synthesizes the empty-permissions minimal stub.
 * Truncated resource packages fail closed (no silent partial import).
 */
export const buildApplyImmediateVersionPayloadFromImport = (
  parsed: AdminSkillParseImportSourceOutput,
): ApplyImmediateVersionPayload | { error: 'resources_truncated' | 'invalid' } => {
  if (parsed.resourcesTruncated) return { error: 'resources_truncated' };
  const content = parsed.content.trim();
  const version = (parsed.packageVersion ?? '1.0.0').trim();
  if (!content || !version) return { error: 'invalid' };
  try {
    const manifest = skillManifestSchema.parse(parsed.manifest);
    const resources = skillResourceSchema.array().max(100).parse(parsed.resources);
    return {
      content,
      // Managed runtime is inline-only; never carry opaque refs through applyImmediate.
      contentRef: null,
      manifest,
      resources,
      version,
    };
  } catch {
    return { error: 'invalid' };
  }
};

/**
 * Version fields for applyImmediate(mode:'create') without CAS tokens.
 * Used for builtin override materialization and other non-import creates that
 * may legitimately synthesize a minimal manifest. Import callers must use
 * {@link buildApplyImmediateVersionPayloadFromImport} instead.
 */
export const buildApplyImmediateVersionPayload = (params: {
  content: string;
  contentRef?: string | null;
  description?: string | null;
  displayName: string;
  /** Explicit manifest when available (still optional for non-import paths). */
  manifest?: SkillManifest;
  manifestText?: string;
  resources?: SkillResource[];
  resourcesText?: string;
  version: string;
}): ApplyImmediateVersionPayload | null => {
  const content = params.content.trim();
  const version = params.version.trim();
  if (!content || !version) return null;
  let manifest: SkillManifest;
  try {
    if (params.manifest) {
      manifest = skillManifestSchema.parse(params.manifest);
    } else if (params.manifestText) {
      manifest = skillManifestSchema.parse(JSON.parse(params.manifestText));
    } else {
      manifest = buildMinimalSkillManifest({
        description: params.description,
        displayName: params.displayName,
      });
    }
  } catch {
    return null;
  }
  let resources: SkillResource[] = [];
  try {
    if (params.resources) {
      resources = skillResourceSchema.array().max(100).parse(params.resources);
    } else if (params.resourcesText) {
      resources = skillResourceSchema.array().max(100).parse(JSON.parse(params.resourcesText));
    }
  } catch {
    return null;
  }
  return {
    content,
    // Managed runtime is inline-only; never carry opaque refs through applyImmediate.
    contentRef: null,
    manifest,
    resources,
    version,
  };
};

const EDITABLE_IDENTITY_FIELDS = [
  'description',
  'displayName',
  'distribution',
  'enabled',
] as const satisfies readonly (keyof EditableSkillIdentityDraft)[];

export const rebaseSkillDraft = (params: {
  latest: EditableSkillDraft;
  local: EditableSkillDraft;
  original: EditableSkillDraft;
}): { conflicts: SkillRebaseConflict[]; draft: EditableSkillDraft } => {
  const identity = structuredClone(params.latest.identity);
  const conflicts: SkillRebaseConflict[] = [];
  for (const field of EDITABLE_IDENTITY_FIELDS) {
    const original = params.original.identity[field];
    const local = params.local.identity[field];
    const latest = params.latest.identity[field];
    const localChanged = !Object.is(local, original);
    const latestChanged = !Object.is(latest, original);
    if (localChanged) (identity[field] as unknown) = structuredClone(local);
    if (localChanged && latestChanged && !Object.is(local, latest)) {
      conflicts.push({ field, latest: structuredClone(latest), local: structuredClone(local) });
    }
  }
  return {
    conflicts,
    draft: {
      identity,
      versionDraft: structuredClone(params.local.versionDraft),
    },
  };
};

export const summarizeSkillValidation = (validation: AdminSkillValidateOutput | null) => ({
  errors: validation?.issues.filter((issue) => issue.severity === 'error').length ?? 0,
  publishable: Boolean(
    validation && !validation.issues.some((issue) => issue.severity === 'error'),
  ),
  warnings: validation?.issues.filter((issue) => issue.severity === 'warning').length ?? 0,
});
