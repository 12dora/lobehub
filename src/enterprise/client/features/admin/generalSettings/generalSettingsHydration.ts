/**
 * Pure decision helper for General Settings draft rehydration.
 * Prevents SWR/server identity churn from silently wiping unsaved edits.
 */

import { normalizeEmailDomainAllowlist } from '@/types/platform/authSettings';

export interface GeneralSettingsDraftSnapshot {
  emailDomainAllowlistEnabled: boolean;
  emailDomainText: string;
  openRegistration: boolean;
}

export type GeneralSettingsHydrationDecision =
  { action: 'accept'; next: GeneralSettingsDraftSnapshot } | { action: 'keep'; markStale: boolean };

export const fingerprintGeneralSettingsDraft = (value: GeneralSettingsDraftSnapshot): string =>
  [
    value.openRegistration ? '1' : '0',
    value.emailDomainAllowlistEnabled ? '1' : '0',
    value.emailDomainText,
  ].join('|');

export const normalizedDraftFingerprint = (draft: GeneralSettingsDraftSnapshot): string =>
  fingerprintGeneralSettingsDraft({
    ...draft,
    emailDomainText: normalizeEmailDomainAllowlist(draft.emailDomainText).join('\n'),
  });

export const decideGeneralSettingsHydration = (params: {
  baselineFp: string | null;
  draftFp: string | null;
  next: GeneralSettingsDraftSnapshot;
  saving: boolean;
}): GeneralSettingsHydrationDecision => {
  const nextFp = fingerprintGeneralSettingsDraft(params.next);

  // First hydrate (or remount with empty local state).
  if (params.baselineFp === null || params.draftFp === null) {
    return { action: 'accept', next: params.next };
  }

  // Same server snapshot as the editor baseline — ignore identity churn.
  if (nextFp === params.baselineFp) {
    return { action: 'keep', markStale: false };
  }

  const isDirty = params.draftFp !== params.baselineFp;
  if (!isDirty && !params.saving) {
    return { action: 'accept', next: params.next };
  }

  // Retain local draft; surface that server moved under the editor.
  return { action: 'keep', markStale: true };
};
