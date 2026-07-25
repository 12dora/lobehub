/**
 * Revision-keyed local recovery for General Settings non-secret drafts.
 * Invalidated when the server revision advances; cleared after a confirmed save.
 */

import {
  carriesLocalDraftSecretMaterial,
  utf8ByteLength,
} from '@/enterprise/client/features/admin/primitives/localDraftSafety';

const PREFIX = 'aihub.admin.generalSettings.draft';
/** 7 days — long enough for a crash/reload, short enough to expire abandoned drafts. */
export const GENERAL_SETTINGS_LOCAL_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 64_000;

export type GeneralSettingsLocalDraft = {
  baseRevision: number;
  draft: {
    emailDomainAllowlistEnabled: boolean;
    emailDomainText: string;
    openRegistration: boolean;
  };
  savedAt: string;
};

export const buildGeneralSettingsLocalDraftKey = (baseRevision: number) =>
  `${PREFIX}:r${baseRevision}`;

export const loadGeneralSettingsLocalDraft = (
  baseRevision: number,
): GeneralSettingsLocalDraft | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(buildGeneralSettingsLocalDraftKey(baseRevision));
    if (!raw) return null;
    if (utf8ByteLength(raw) > MAX_BYTES) {
      window.localStorage.removeItem(buildGeneralSettingsLocalDraftKey(baseRevision));
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<GeneralSettingsLocalDraft>;
    if (
      parsed.baseRevision !== baseRevision ||
      !parsed.draft ||
      typeof parsed.draft.emailDomainAllowlistEnabled !== 'boolean' ||
      typeof parsed.draft.emailDomainText !== 'string' ||
      typeof parsed.draft.openRegistration !== 'boolean' ||
      typeof parsed.savedAt !== 'string'
    ) {
      return null;
    }
    const age = Date.now() - Date.parse(parsed.savedAt);
    if (!Number.isFinite(age) || age < 0 || age > GENERAL_SETTINGS_LOCAL_DRAFT_TTL_MS) {
      window.localStorage.removeItem(buildGeneralSettingsLocalDraftKey(baseRevision));
      return null;
    }
    if (carriesLocalDraftSecretMaterial(parsed.draft)) {
      window.localStorage.removeItem(buildGeneralSettingsLocalDraftKey(baseRevision));
      return null;
    }
    return {
      baseRevision: parsed.baseRevision,
      draft: {
        emailDomainAllowlistEnabled: parsed.draft.emailDomainAllowlistEnabled,
        emailDomainText: parsed.draft.emailDomainText,
        openRegistration: parsed.draft.openRegistration,
      },
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
};

export const saveGeneralSettingsLocalDraft = (payload: GeneralSettingsLocalDraft) => {
  if (typeof window === 'undefined') return;
  if (carriesLocalDraftSecretMaterial(payload.draft)) return;
  try {
    const raw = JSON.stringify(payload);
    if (utf8ByteLength(raw) > MAX_BYTES) return;
    window.localStorage.setItem(buildGeneralSettingsLocalDraftKey(payload.baseRevision), raw);
  } catch {
    /* quota / private mode */
  }
};

export const clearGeneralSettingsLocalDraft = (baseRevision: number) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(buildGeneralSettingsLocalDraftKey(baseRevision));
  } catch {
    /* ignore */
  }
};
