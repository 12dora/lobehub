import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminBrandingPayload } from '@/enterprise/client/services/adminBranding';

import { hasBrandingChanges, useBrandingEditorStore } from './store';

const payload = (name: string): AdminBrandingPayload => ({
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
  it('keeps the server CAS state and baseline separate from dirty form edits', () => {
    useBrandingEditorStore.getState().adopt({
      branding: payload('Server'),
      revision: 2,
      token: 'server-token',
    });
    useBrandingEditorStore.getState().patch({ name: 'Local' });

    expect(useBrandingEditorStore.getState()).toMatchObject({
      baseline: { name: 'Server' },
      branding: { name: 'Local' },
      editorState: 'dirty',
      revision: 2,
      token: 'server-token',
    });
  });

  it('marks conflicts without overwriting the local form', () => {
    useBrandingEditorStore.getState().adopt({
      branding: payload('Local'),
      revision: 2,
      token: 'old-token',
    });
    useBrandingEditorStore.getState().patch({ name: 'Unsaved' });
    useBrandingEditorStore.getState().markConflict();

    expect(useBrandingEditorStore.getState()).toMatchObject({
      branding: { name: 'Unsaved' },
      editorState: 'conflict',
      token: 'old-token',
    });
  });

  it('stays conflicted when patches arrive before the admin reloads', () => {
    useBrandingEditorStore.getState().adopt({
      branding: payload('Live'),
      revision: 2,
      token: 'live-token',
    });
    useBrandingEditorStore.getState().markConflict();
    // The UI disables fields while conflicted; a stray patch must never clear the conflict.
    useBrandingEditorStore.getState().patch({ name: 'Stray Edit' });

    expect(useBrandingEditorStore.getState()).toMatchObject({
      editorState: 'conflict',
      token: 'live-token',
    });
  });

  it('adopts the saved values as the new baseline', () => {
    useBrandingEditorStore.getState().adopt({
      branding: payload('Before'),
      revision: 2,
      token: 'old-token',
    });
    useBrandingEditorStore.getState().patch({ name: 'After' });
    useBrandingEditorStore.getState().adopt({
      branding: payload('After'),
      revision: 3,
      token: 'new-token',
    });

    const state = useBrandingEditorStore.getState();
    expect(state).toMatchObject({ editorState: 'idle', revision: 3, token: 'new-token' });
    expect(hasBrandingChanges(state.branding, state.baseline)).toBe(false);
  });

  it('refuses a snapshot older than the newest revision already observed', () => {
    useBrandingEditorStore.getState().adopt({
      branding: payload('Live'),
      revision: 3,
      token: 'live-token',
    });

    const adopted = useBrandingEditorStore.getState().adopt({
      branding: payload('Stale'),
      revision: 2,
      token: 'stale-token',
    });

    expect(adopted).toBe(false);
    expect(useBrandingEditorStore.getState()).toMatchObject({
      branding: { name: 'Live' },
      revision: 3,
      token: 'live-token',
    });
  });

  it('remembers a revision it only observed through a conflict', () => {
    useBrandingEditorStore.getState().adopt({
      branding: payload('Live'),
      revision: 2,
      token: 'live-token',
    });
    // A newer read arrived while local edits were pending: never adopted, but observed.
    useBrandingEditorStore.getState().markConflict(4);

    const adopted = useBrandingEditorStore.getState().adopt({
      branding: payload('Late Response'),
      revision: 3,
      token: 'late-token',
    });

    expect(adopted).toBe(false);
    expect(useBrandingEditorStore.getState()).toMatchObject({
      editorState: 'conflict',
      observedRevision: 4,
      revision: 2,
    });
  });

  it('returns to idle when every edited field is restored to the baseline', () => {
    useBrandingEditorStore.getState().adopt({
      branding: payload('Live'),
      revision: 2,
      token: 'live-token',
    });
    useBrandingEditorStore.getState().patch({ name: 'Edited' });
    expect(useBrandingEditorStore.getState().editorState).toBe('dirty');

    useBrandingEditorStore.getState().patch({ name: 'Live' });

    expect(useBrandingEditorStore.getState().editorState).toBe('idle');
  });

  it('merges desktop patches into the values current at merge time', () => {
    useBrandingEditorStore.getState().adopt({
      branding: payload('Live'),
      revision: 2,
      token: 'live-token',
    });
    // A newer snapshot lands while an upload is in flight.
    useBrandingEditorStore.getState().adopt({
      branding: { ...payload('Live'), desktop: { iconUrl: null, productName: 'Renamed' } },
      revision: 3,
      token: 'newer-token',
    });

    useBrandingEditorStore.getState().patchDesktop({ iconUrl: '/f/icon' });

    expect(useBrandingEditorStore.getState()).toMatchObject({
      branding: { desktop: { iconUrl: '/f/icon', productName: 'Renamed' } },
      editorState: 'dirty',
    });
  });
});

describe('hasBrandingChanges', () => {
  it('reports no change for an edit that was typed and then undone', () => {
    expect(hasBrandingChanges(payload('Same'), payload('Same'))).toBe(false);
    expect(hasBrandingChanges(payload('Changed'), payload('Same'))).toBe(true);
  });

  it('needs both sides before it can claim a change', () => {
    expect(hasBrandingChanges(null, payload('Same'))).toBe(false);
    expect(hasBrandingChanges(payload('Same'), null)).toBe(false);
  });
});
