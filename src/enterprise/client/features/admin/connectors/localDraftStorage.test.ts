import { beforeEach, describe, expect, it } from 'vitest';

import { loadAdminConnectorDraft, saveAdminConnectorDraft } from './localDraftStorage';

describe('Connector local draft storage', () => {
  beforeEach(() => localStorage.clear());

  it('persists only public draft fields and never accepts a secret slot', () => {
    saveAdminConnectorDraft('connector-1', {
      baseRevision: 1,
      draft: {
        credentialMode: 'none',
        description: '',
        displayName: 'Calendar',
        enabled: true,
        endpoint: 'https://calendar.example.com/mcp',
        oauthAuthorizationEndpoint: '',
        oauthClientId: '',
        oauthIssuer: '',
        oauthScopes: '',
        oauthTokenEndpoint: '',
        sort: 0,
        tools: [],
      },
      draftToken: 'a'.repeat(64),
      savedAt: new Date(0).toISOString(),
    });

    const raw = localStorage.getItem('aihub.admin.connectors.draft.connector-1');
    expect(raw).not.toContain('secret');
    expect(loadAdminConnectorDraft('connector-1')?.draft.displayName).toBe('Calendar');
  });
});
