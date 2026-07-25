/**
 * Revision-keyed local recovery for Branding non-secret drafts.
 * Invalidated when the server revision advances; cleared after a confirmed save/publish.
 */

import {
  carriesLocalDraftSecretMaterial,
  utf8ByteLength,
} from '@/enterprise/client/features/admin/primitives/localDraftSafety';
import type { AdminBrandingDraft } from '@/server/enterprise/contracts/adminBranding';

const PREFIX = 'aihub.admin.branding.draft';
export const BRANDING_LOCAL_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 256_000;

export type BrandingLocalDraft = {
  baseRevision: number;
  draft: AdminBrandingDraft;
  draftToken: string;
  savedAt: string;
};

export const buildBrandingLocalDraftKey = (baseRevision: number) => `${PREFIX}:r${baseRevision}`;

export const loadBrandingLocalDraft = (baseRevision: number): BrandingLocalDraft | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(buildBrandingLocalDraftKey(baseRevision));
    if (!raw) return null;
    if (utf8ByteLength(raw) > MAX_BYTES) {
      window.localStorage.removeItem(buildBrandingLocalDraftKey(baseRevision));
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<BrandingLocalDraft>;
    if (
      parsed.baseRevision !== baseRevision ||
      !parsed.draft ||
      typeof parsed.draft !== 'object' ||
      typeof parsed.draftToken !== 'string' ||
      typeof parsed.savedAt !== 'string'
    ) {
      return null;
    }
    const age = Date.now() - Date.parse(parsed.savedAt);
    if (!Number.isFinite(age) || age < 0 || age > BRANDING_LOCAL_DRAFT_TTL_MS) {
      window.localStorage.removeItem(buildBrandingLocalDraftKey(baseRevision));
      return null;
    }
    if (carriesLocalDraftSecretMaterial(parsed.draft)) {
      window.localStorage.removeItem(buildBrandingLocalDraftKey(baseRevision));
      return null;
    }
    return {
      baseRevision: parsed.baseRevision,
      draft: parsed.draft as AdminBrandingDraft,
      draftToken: parsed.draftToken,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
};

export const saveBrandingLocalDraft = (payload: BrandingLocalDraft) => {
  if (typeof window === 'undefined') return;
  if (carriesLocalDraftSecretMaterial(payload.draft)) return;
  try {
    const raw = JSON.stringify(payload);
    if (utf8ByteLength(raw) > MAX_BYTES) return;
    window.localStorage.setItem(buildBrandingLocalDraftKey(payload.baseRevision), raw);
  } catch {
    /* quota / private mode */
  }
};

export const clearBrandingLocalDraft = (baseRevision: number) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(buildBrandingLocalDraftKey(baseRevision));
  } catch {
    /* ignore */
  }
};
