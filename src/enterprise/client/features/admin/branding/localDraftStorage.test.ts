// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearBrandingLocalDraft,
  loadBrandingLocalDraft,
  saveBrandingLocalDraft,
} from './localDraftStorage';

const sampleDraft = {
  defaultAgentDisplayName: 'Agent',
  desktop: { iconUrl: null, productName: null },
  desktopIcon: null,
  desktopProductName: null,
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: null,
  logoUrl: null,
  name: 'Acme',
  ogImageUrl: null,
  pageTitleTemplate: null,
  primaryColor: '#000000',
  privacyUrl: null,
  shortName: 'Acme',
  supportUrl: null,
  termsUrl: null,
  theme: 'auto' as const,
  themeDefaults: { primaryColor: null },
};

describe('branding localDraftStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('restores same-revision drafts and ignores other revisions', () => {
    saveBrandingLocalDraft({
      baseRevision: 2,
      draft: sampleDraft,
      draftToken: 'tok',
      savedAt: new Date().toISOString(),
    });
    expect(loadBrandingLocalDraft(2)?.draft.name).toBe('Acme');
    expect(loadBrandingLocalDraft(3)).toBeNull();
  });

  it('clears after save', () => {
    saveBrandingLocalDraft({
      baseRevision: 1,
      draft: sampleDraft,
      draftToken: 'tok',
      savedAt: new Date().toISOString(),
    });
    clearBrandingLocalDraft(1);
    expect(loadBrandingLocalDraft(1)).toBeNull();
  });
});
