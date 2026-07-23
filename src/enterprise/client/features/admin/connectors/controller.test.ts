import { describe, expect, it } from 'vitest';

import type { EditableAdminConnectorDraft } from './controller';
import {
  buildConnectorUpdatePayload,
  changeConnectorCredentialMode,
  clearConnectorSecretEdit,
  deriveAdminConnectorPermissions,
  normalizeConnectorTools,
  resolveAdminConnectorPrimaryAction,
  sortConnectorTools,
  updateConnectorSecretEdit,
  updateConnectorToolPolicy,
  validateConnectorRollbackTarget,
  validateEditableAdminConnectorDraft,
} from './controller';
import type { AdminConnectorGetOutput } from './types';

const draft = (): EditableAdminConnectorDraft => ({
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
});

const sharedSnapshot = (): AdminConnectorGetOutput => ({
  baseRevision: 7,
  draft: {
    connectionTest: null,
    credentialMode: 'shared_service_account',
    description: null,
    displayName: 'Calendar',
    enabled: true,
    endpoint: 'https://calendar.example.com/mcp',
    id: 'connector-1',
    key: 'calendar',
    oauthClientSecret: { configured: false, fingerprint: null, updatedAt: null },
    oauthConfig: null,
    revision: 7,
    sharedSecret: { configured: true, fingerprint: 'sha256:x', updatedAt: null },
    sort: 0,
    status: 'draft',
    tools: [],
    transport: 'http',
  },
  draftToken: 'a'.repeat(64),
  published: null,
});

describe('admin Connector controller', () => {
  it('keeps auditor access read-only', () => {
    expect(deriveAdminConnectorPermissions(['platform_connector:read:all'])).toEqual({
      canArchive: false,
      canCreate: false,
      canDelete: false,
      canDiscover: false,
      canPublish: false,
      canRead: true,
      canReadAudit: false,
      canRevokeBindings: false,
      canTest: false,
      canUpdate: false,
    });
  });

  it('requires the complete public OAuth configuration without accepting credential URLs', () => {
    const value = draft();
    value.credentialMode = 'per_user_oauth';
    value.endpoint = 'https://user:password@example.com/mcp';
    expect(validateEditableAdminConnectorDraft(value)).toMatchObject({
      errors: {
        endpoint: 'httpUrl',
        oauthAuthorizationEndpoint: 'httpUrl',
        oauthClientId: 'required',
        oauthIssuer: 'httpUrl',
        oauthScopes: 'required',
        oauthTokenEndpoint: 'httpUrl',
      },
      valid: false,
    });
  });

  it('keeps one primary action through save, test, and publish', () => {
    expect(
      resolveAdminConnectorPrimaryAction({
        canPublish: true,
        canSave: true,
        canTest: true,
        conflict: false,
        dirty: true,
        saveFailed: false,
        testPassed: false,
      }),
    ).toBe('save');
    expect(
      resolveAdminConnectorPrimaryAction({
        canPublish: true,
        canSave: true,
        canTest: true,
        conflict: false,
        dirty: false,
        saveFailed: false,
        testPassed: true,
      }),
    ).toBe('publish');
  });

  it('updates only the selected Tool policy', () => {
    const tools = [
      {
        description: null,
        displayName: 'Read',
        enabled: true,
        id: 'tool-1',
        inputSchema: {},
        outputSchema: {},
        platformPolicy: 'allow' as const,
        requiresConfirmation: false,
        riskLevel: 'low' as const,
        sort: 0,
        toolKey: 'read',
      },
    ];
    expect(updateConnectorToolPolicy(tools, 'tool-1', { platformPolicy: 'deny' })[0]).toMatchObject(
      { enabled: true, platformPolicy: 'deny' },
    );
  });

  it('builds an optimistic concurrency payload without persisting a secret', () => {
    const value = draft();
    value.credentialMode = 'shared_service_account';
    const snapshot = {
      baseRevision: 7,
      draft: {
        connectionTest: null,
        credentialMode: 'shared_service_account',
        description: null,
        displayName: 'Calendar',
        enabled: true,
        endpoint: 'https://calendar.example.com/mcp',
        id: 'connector-1',
        key: 'calendar',
        oauthClientSecret: { configured: false, fingerprint: null, updatedAt: null },
        oauthConfig: null,
        revision: 7,
        sharedSecret: { configured: true, fingerprint: 'sha256:x', updatedAt: null },
        sort: 0,
        status: 'draft',
        tools: [],
        transport: 'http',
      },
      draftToken: 'a'.repeat(64),
      published: null,
    } satisfies AdminConnectorGetOutput;
    expect(
      buildConnectorUpdatePayload({
        draft: value,
        reason: 'rotate credential',
        secret: updateConnectorSecretEdit('private-token'),
        snapshot,
      }),
    ).toMatchObject({
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 7,
      id: 'connector-1',
      sharedSecret: { operation: 'replace', value: { bearerToken: 'private-token' } },
    });
  });

  it('switches credential mode without mutating unrelated draft fields', () => {
    const shared = draft();
    shared.credentialMode = 'shared_service_account';
    shared.displayName = 'Shared connector';
    const oauth = changeConnectorCredentialMode(shared, 'per_user_oauth');
    expect(oauth).toMatchObject({
      credentialMode: 'per_user_oauth',
      displayName: 'Shared connector',
    });

    const backToShared = changeConnectorCredentialMode(oauth, 'shared_service_account');
    expect(backToShared.credentialMode).toBe('shared_service_account');
  });

  it('emits explicit shared credential replace and clear operations', () => {
    const value = draft();
    value.credentialMode = 'shared_service_account';

    expect(
      buildConnectorUpdatePayload({
        draft: value,
        reason: 'replace',
        secret: updateConnectorSecretEdit('shared-token'),
        snapshot: sharedSnapshot(),
      }),
    ).toMatchObject({
      sharedSecret: { operation: 'replace', value: { bearerToken: 'shared-token' } },
    });
    expect(
      buildConnectorUpdatePayload({
        draft: value,
        reason: 'clear',
        secret: clearConnectorSecretEdit(),
        snapshot: sharedSnapshot(),
      }),
    ).toMatchObject({ sharedSecret: { operation: 'clear' } });
  });

  it('emits explicit OAuth credential replace and clear without reusing the shared secret slot', () => {
    const value = draft();
    value.credentialMode = 'per_user_oauth';
    value.oauthAuthorizationEndpoint = 'https://identity.example.com/authorize';
    value.oauthClientId = 'calendar-client';
    value.oauthIssuer = 'https://identity.example.com';
    value.oauthScopes = 'calendar.read';
    value.oauthTokenEndpoint = 'https://identity.example.com/token';

    expect(
      buildConnectorUpdatePayload({
        draft: value,
        reason: 'replace',
        secret: updateConnectorSecretEdit('oauth-secret'),
        snapshot: sharedSnapshot(),
      }),
    ).toMatchObject({
      oauthClientSecret: { operation: 'replace', value: 'oauth-secret' },
    });
    expect(
      buildConnectorUpdatePayload({
        draft: value,
        reason: 'clear',
        secret: clearConnectorSecretEdit(),
        snapshot: sharedSnapshot(),
      }),
    ).toMatchObject({ oauthClientSecret: { operation: 'clear' } });
  });

  it('edits Tool risk and integer sort with stable ordering and enforced confirmation', () => {
    const tools = [
      {
        description: null,
        displayName: 'Zulu',
        enabled: true,
        id: 'tool-z',
        inputSchema: {},
        outputSchema: {},
        platformPolicy: 'allow' as const,
        requiresConfirmation: false,
        riskLevel: 'low' as const,
        sort: 2,
        toolKey: 'zulu',
      },
      {
        description: null,
        displayName: 'Alpha',
        enabled: true,
        id: 'tool-a',
        inputSchema: {},
        outputSchema: {},
        platformPolicy: 'allow' as const,
        requiresConfirmation: false,
        riskLevel: 'medium' as const,
        sort: 1,
        toolKey: 'alpha',
      },
    ];

    const updated = updateConnectorToolPolicy(tools, 'tool-z', {
      requiresConfirmation: false,
      riskLevel: 'critical',
      sort: 1,
    });
    expect(updated.map((tool) => tool.toolKey)).toEqual(['alpha', 'zulu']);
    expect(updated[1]).toMatchObject({
      requiresConfirmation: true,
      riskLevel: 'critical',
      sort: 1,
    });
    expect(updateConnectorToolPolicy(updated, 'tool-z', { sort: 1.5 })[1]?.sort).toBe(1);
    expect(sortConnectorTools([...updated].reverse())).toEqual(updated);
    expect(
      normalizeConnectorTools([{ ...updated[1]!, requiresConfirmation: false }])[0],
    ).toMatchObject({ requiresConfirmation: true });
  });

  it('accepts only a positive rollback revision different from the published head', () => {
    expect(validateConnectorRollbackTarget(null, 7)).toBe('positiveInteger');
    expect(validateConnectorRollbackTarget(1.5, 7)).toBe('positiveInteger');
    expect(validateConnectorRollbackTarget(0, 7)).toBe('positiveInteger');
    expect(validateConnectorRollbackTarget(7, 7)).toBe('currentRevision');
    expect(validateConnectorRollbackTarget(3, 7)).toBeNull();
  });
});
