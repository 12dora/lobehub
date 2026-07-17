import { beforeEach, describe, expect, it } from 'vitest';

import type { StoredAdminConnectorDraft } from './localDraftStorage';
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

  it('strips unexpected secret-shaped fields on save and recovery', () => {
    const value = {
      baseRevision: 1,
      draft: {
        credentialMode: 'shared_service_account',
        description: '',
        displayName: 'Calendar',
        enabled: true,
        endpoint: 'https://calendar.example.com/mcp',
        oauthAuthorizationEndpoint: '',
        oauthClientId: '',
        oauthIssuer: '',
        oauthScopes: '',
        oauthTokenEndpoint: '',
        secret: 'must-not-persist',
        sort: 0,
        tools: [],
      },
      draftToken: 'a'.repeat(64),
      savedAt: new Date(0).toISOString(),
    } as unknown as StoredAdminConnectorDraft;
    saveAdminConnectorDraft('connector-1', value);
    expect(localStorage.getItem('aihub.admin.connectors.draft.connector-1')).not.toContain(
      'must-not-persist',
    );

    localStorage.setItem('aihub.admin.connectors.draft.connector-1', JSON.stringify(value));
    expect(loadAdminConnectorDraft('connector-1')?.draft).not.toHaveProperty('secret');
    expect(localStorage.getItem('aihub.admin.connectors.draft.connector-1')).not.toContain(
      'must-not-persist',
    );
  });
});
