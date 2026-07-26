/**
 * Durable local draft persistence for admin settings editor.
 * Keyed by registry version + base revision so stale drafts are not restored after publish.
 */

import {
  carriesLocalDraftSecretMaterial,
  utf8ByteLength,
} from '@/enterprise/client/features/admin/primitives/localDraftSafety';

import { isSettingsPolicyDraftMap } from './settingsPolicyDraftValidation';

const PREFIX = 'aihub.admin.settings.draft';
export const SETTINGS_POLICY_LOCAL_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 512_000;

export type LocalDraftPayload = {
  /** Server draft snapshot this local work started from (three-way CAS rebase). */
  originalBaseDraft: Record<
    string,
    {
      mode: 'user' | 'default' | 'locked';
      schemaVersion: number;
      value?: unknown;
      visibility: 'visible' | 'hidden';
    }
  >;
  draft: Record<
    string,
    {
      mode: 'user' | 'default' | 'locked';
      schemaVersion: number;
      value?: unknown;
      visibility: 'visible' | 'hidden';
    }
  >;
  registryVersion: number;
  baseRevision: number;
  draftToken: string;
  savedAt: string;
};

export const buildLocalDraftKey = (registryVersion: number, baseRevision: number) =>
  `${PREFIX}:v${registryVersion}:r${baseRevision}`;

export const pruneLocalDrafts = (registryVersion: number, baseRevision: number) => {
  if (typeof window === 'undefined') return;
  const retainedKey = buildLocalDraftKey(registryVersion, baseRevision);
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(`${PREFIX}:`) && key !== retainedKey) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* private mode */
  }
};

export const loadLocalDraft = (
  registryVersion: number,
  baseRevision: number,
): LocalDraftPayload | null => {
  if (typeof window === 'undefined') return null;
  const key = buildLocalDraftKey(registryVersion, baseRevision);
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    if (utf8ByteLength(raw) > MAX_BYTES) {
      window.localStorage.removeItem(key);
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<LocalDraftPayload>;
    if (
      parsed.registryVersion !== registryVersion ||
      parsed.baseRevision !== baseRevision ||
      !isSettingsPolicyDraftMap(parsed.draft) ||
      !isSettingsPolicyDraftMap(parsed.originalBaseDraft) ||
      typeof parsed.draftToken !== 'string' ||
      typeof parsed.savedAt !== 'string'
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    const age = Date.now() - Date.parse(parsed.savedAt);
    if (!Number.isFinite(age) || age < 0 || age > SETTINGS_POLICY_LOCAL_DRAFT_TTL_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    if (
      carriesLocalDraftSecretMaterial(parsed.draft) ||
      carriesLocalDraftSecretMaterial(parsed.originalBaseDraft)
    ) {
      window.localStorage.removeItem(key);
      return null;
    }
    return {
      baseRevision: parsed.baseRevision,
      draft: parsed.draft,
      draftToken: parsed.draftToken,
      originalBaseDraft: parsed.originalBaseDraft,
      registryVersion: parsed.registryVersion,
      savedAt: parsed.savedAt,
    };
  } catch {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* private mode */
    }
    return null;
  }
};

export const saveLocalDraft = (payload: LocalDraftPayload) => {
  if (typeof window === 'undefined') return;
  if (
    carriesLocalDraftSecretMaterial(payload.draft) ||
    carriesLocalDraftSecretMaterial(payload.originalBaseDraft)
  ) {
    return;
  }
  try {
    const raw = JSON.stringify(payload);
    if (utf8ByteLength(raw) > MAX_BYTES) return;
    window.localStorage.setItem(
      buildLocalDraftKey(payload.registryVersion, payload.baseRevision),
      raw,
    );
    pruneLocalDrafts(payload.registryVersion, payload.baseRevision);
  } catch {
    /* quota / private mode */
  }
};

export const clearLocalDraft = (registryVersion: number, baseRevision: number) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(buildLocalDraftKey(registryVersion, baseRevision));
  } catch {
    /* ignore */
  }
};
