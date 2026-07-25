// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearGeneralSettingsLocalDraft,
  loadGeneralSettingsLocalDraft,
  saveGeneralSettingsLocalDraft,
} from './localDraftStorage';

describe('generalSettings localDraftStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips a revision-keyed draft', () => {
    saveGeneralSettingsLocalDraft({
      baseRevision: 3,
      draft: {
        emailDomainAllowlistEnabled: true,
        emailDomainText: 'example.com',
        openRegistration: false,
      },
      savedAt: new Date().toISOString(),
    });
    expect(loadGeneralSettingsLocalDraft(3)?.draft.emailDomainText).toBe('example.com');
    expect(loadGeneralSettingsLocalDraft(2)).toBeNull();
  });

  it('rejects stale revisions and clears after clear()', () => {
    saveGeneralSettingsLocalDraft({
      baseRevision: 1,
      draft: {
        emailDomainAllowlistEnabled: false,
        emailDomainText: '',
        openRegistration: true,
      },
      savedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(loadGeneralSettingsLocalDraft(1)).toBeNull();

    saveGeneralSettingsLocalDraft({
      baseRevision: 5,
      draft: {
        emailDomainAllowlistEnabled: false,
        emailDomainText: 'x.com',
        openRegistration: true,
      },
      savedAt: new Date().toISOString(),
    });
    clearGeneralSettingsLocalDraft(5);
    expect(loadGeneralSettingsLocalDraft(5)).toBeNull();
  });
});
