import { describe, expect, it } from 'vitest';

import type { EditableAdminConnectorDraft } from './controller';
import {
  buildConnectorUpdatePayload,
  deriveAdminConnectorPermissions,
  resolveAdminConnectorPrimaryAction,
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
        secretValue: 'private-token',
        snapshot,
      }),
    ).toMatchObject({
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 7,
      id: 'connector-1',
      sharedSecret: { operation: 'replace', value: { bearerToken: 'private-token' } },
    });
  });

  it('accepts only a positive rollback revision different from the published head', () => {
    expect(validateConnectorRollbackTarget(null, 7)).toBe('positiveInteger');
    expect(validateConnectorRollbackTarget(1.5, 7)).toBe('positiveInteger');
    expect(validateConnectorRollbackTarget(0, 7)).toBe('positiveInteger');
    expect(validateConnectorRollbackTarget(7, 7)).toBe('currentRevision');
    expect(validateConnectorRollbackTarget(3, 7)).toBeNull();
  });
});
