import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminBrandingDraft } from '@/server/enterprise/contracts/adminBranding';

import { useBrandingEditorStore } from './store';

const draft = (name: string): AdminBrandingDraft => ({
  defaultAgentDisplayName: null,
  desktop: { iconUrl: null, productName: null },
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: null,
  logoUrl: null,
  name,
  ogImageUrl: null,
  pageTitleTemplate: null,
  privacyUrl: null,
  shortName: null,
  supportUrl: null,
  termsUrl: null,
  themeDefaults: { primaryColor: null },
});

beforeEach(() => useBrandingEditorStore.getState().reset());

describe('Branding editor store', () => {
  it('keeps server CAS state separate from dirty form edits', () => {
    const state = useBrandingEditorStore.getState();
    state.hydrate({ baseRevision: 2, draft: draft('Server'), draftToken: 'server-token' });
    useBrandingEditorStore.getState().patch({ name: 'Local' });

    expect(useBrandingEditorStore.getState()).toMatchObject({
      baseRevision: 2,
      draft: { name: 'Local' },
      draftToken: 'server-token',
      editorState: 'dirty',
    });
  });

  it('marks conflicts without overwriting the local form', () => {
    useBrandingEditorStore.getState().hydrate({
      baseRevision: 2,
      draft: draft('Local'),
      draftToken: 'old-token',
    });
    useBrandingEditorStore.getState().patch({ name: 'Unsaved' });
    useBrandingEditorStore.getState().markConflict();

    expect(useBrandingEditorStore.getState()).toMatchObject({
      draft: { name: 'Unsaved' },
      draftToken: 'old-token',
      editorState: 'conflict',
    });
  });
});
