import {
  skillManifestSchema,
  skillResourceSchema,
} from '@/server/enterprise/contracts/skillCatalog';
import { containsEnterpriseSecretMaterial } from '@/server/enterprise/security/redaction/detectSecretMaterial';

import type {
  EditableSkillDraft,
  EditableSkillIdentityDraft,
  EditableSkillVersionDraft,
} from './controller';

const STORAGE_PREFIX = 'aihub.admin.skills.draft.';
const MAX_LOCAL_DRAFT_BYTES = 1_900_000;
const MAX_MANIFEST_TEXT_BYTES = 262_144;
const MAX_RESOURCES_TEXT_BYTES = 1_500_000;

export type SkillDraftPersistenceStatus =
  'saved' | 'invalid' | 'sensitive' | 'too_large' | 'unavailable';

export interface StoredSkillDraft {
  baseDraft: EditableSkillDraft;
  baseDraftSequence: number;
  baseRevision: number;
  draft: EditableSkillDraft;
  savedAt: string;
}

const storageKey = (id: string) => `${STORAGE_PREFIX}${id}`;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const normalizeIdentity = (value: unknown): EditableSkillIdentityDraft | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(identity, ['description', 'displayName', 'distribution', 'enabled']) ||
    typeof identity.description !== 'string' ||
    identity.description.length > 4000 ||
    typeof identity.displayName !== 'string' ||
    identity.displayName.length === 0 ||
    identity.displayName.length > 200 ||
    !['default', 'mandatory', 'optional'].includes(String(identity.distribution)) ||
    typeof identity.enabled !== 'boolean'
  ) {
    return null;
  }
  return {
    description: identity.description,
    displayName: identity.displayName,
    distribution: identity.distribution as EditableSkillIdentityDraft['distribution'],
    enabled: identity.enabled,
  };
};

const normalizeVersionDraft = (value: unknown): EditableSkillVersionDraft | null => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(draft, ['content', 'contentRef', 'manifestText', 'resourcesText', 'version']) ||
    typeof draft.content !== 'string' ||
    byteLength(draft.content) > 1_048_576 ||
    typeof draft.contentRef !== 'string' ||
    draft.contentRef.length > 520 ||
    typeof draft.manifestText !== 'string' ||
    byteLength(draft.manifestText) > MAX_MANIFEST_TEXT_BYTES ||
    typeof draft.resourcesText !== 'string' ||
    byteLength(draft.resourcesText) > MAX_RESOURCES_TEXT_BYTES ||
    typeof draft.version !== 'string' ||
    draft.version.length > 64
  ) {
    return null;
  }
  try {
    skillManifestSchema.parse(JSON.parse(draft.manifestText));
    skillResourceSchema.array().max(100).parse(JSON.parse(draft.resourcesText));
  } catch {
    // Invalid in-progress JSON remains in memory, but never enters durable storage.
    return null;
  }
  return {
    content: draft.content,
    contentRef: draft.contentRef,
    manifestText: draft.manifestText,
    resourcesText: draft.resourcesText,
    version: draft.version,
  };
};

const normalizeDraft = (value: unknown): EditableSkillDraft | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  if (!hasOnlyKeys(draft, ['identity', 'versionDraft'])) return null;
  const identity = normalizeIdentity(draft.identity);
  const versionDraft = normalizeVersionDraft(draft.versionDraft);
  if (!identity || (draft.versionDraft !== null && !versionDraft)) return null;
  return { identity, versionDraft };
};

const removeStoredDraft = (id: string) => {
  try {
    window.localStorage.removeItem(storageKey(id));
  } catch {
    // Storage may be unavailable; the in-memory editor remains intact.
  }
};

export const saveSkillLocalDraft = (
  id: string,
  payload: StoredSkillDraft,
): SkillDraftPersistenceStatus => {
  if (typeof window === 'undefined') return 'unavailable';
  if (
    !Number.isInteger(payload.baseDraftSequence) ||
    payload.baseDraftSequence < 0 ||
    !Number.isInteger(payload.baseRevision) ||
    payload.baseRevision < 0 ||
    typeof payload.savedAt !== 'string' ||
    !Number.isFinite(Date.parse(payload.savedAt))
  ) {
    removeStoredDraft(id);
    return 'invalid';
  }
  const rawPayload = JSON.stringify(payload);
  if (byteLength(rawPayload) > MAX_LOCAL_DRAFT_BYTES) {
    removeStoredDraft(id);
    return 'too_large';
  }
  const normalizedBase = normalizeDraft(payload.baseDraft);
  const normalizedDraft = normalizeDraft(payload.draft);
  if (!normalizedBase || !normalizedDraft) {
    removeStoredDraft(id);
    return 'invalid';
  }
  const safePayload = {
    baseDraft: normalizedBase,
    baseDraftSequence: payload.baseDraftSequence,
    baseRevision: payload.baseRevision,
    draft: normalizedDraft,
    savedAt: payload.savedAt,
  } satisfies StoredSkillDraft;
  if (containsEnterpriseSecretMaterial(safePayload)) {
    removeStoredDraft(id);
    return 'sensitive';
  }
  const serialized = JSON.stringify(safePayload);
  if (byteLength(serialized) > MAX_LOCAL_DRAFT_BYTES) {
    removeStoredDraft(id);
    return 'too_large';
  }
  try {
    window.localStorage.setItem(storageKey(id), serialized);
    return 'saved';
  } catch {
    return 'unavailable';
  }
};

export const loadSkillLocalDraft = (id: string): StoredSkillDraft | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(id));
    if (!raw) return null;
    if (byteLength(raw) > MAX_LOCAL_DRAFT_BYTES) {
      removeStoredDraft(id);
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredSkillDraft>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !hasOnlyKeys(parsed as Record<string, unknown>, [
        'baseDraft',
        'baseDraftSequence',
        'baseRevision',
        'draft',
        'savedAt',
      ])
    ) {
      removeStoredDraft(id);
      return null;
    }
    const baseDraft = normalizeDraft(parsed.baseDraft);
    const draft = normalizeDraft(parsed.draft);
    if (
      !baseDraft ||
      !draft ||
      typeof parsed.baseDraftSequence !== 'number' ||
      !Number.isInteger(parsed.baseDraftSequence) ||
      parsed.baseDraftSequence < 0 ||
      typeof parsed.baseRevision !== 'number' ||
      !Number.isInteger(parsed.baseRevision) ||
      parsed.baseRevision < 0 ||
      typeof parsed.savedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.savedAt)) ||
      containsEnterpriseSecretMaterial(parsed)
    ) {
      removeStoredDraft(id);
      return null;
    }
    return {
      baseDraft,
      baseDraftSequence: parsed.baseDraftSequence,
      baseRevision: parsed.baseRevision,
      draft,
      savedAt: parsed.savedAt,
    };
  } catch {
    removeStoredDraft(id);
    return null;
  }
};

export const clearSkillLocalDraft = (id: string): void => {
  if (typeof window === 'undefined') return;
  removeStoredDraft(id);
};
