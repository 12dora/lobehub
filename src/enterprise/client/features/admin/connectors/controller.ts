import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import type {
  AdminConnectorDraft,
  AdminConnectorGetOutput,
  AdminConnectorToolDraft,
  ConnectorCredentialMode,
} from './types';

export interface AdminConnectorPermissions {
  canArchive: boolean;
  canCreate: boolean;
  canDelete: boolean;
  canDiscover: boolean;
  canPublish: boolean;
  canRead: boolean;
  canRevokeBindings: boolean;
  canTest: boolean;
  canUpdate: boolean;
}

export const deriveAdminConnectorPermissions = (
  permissions: readonly string[],
): AdminConnectorPermissions => {
  const granted = new Set(permissions);
  return {
    canArchive: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_DELETE),
    canCreate: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_CREATE),
    canDelete: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_DELETE),
    canDiscover: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_TEST),
    canPublish: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH),
    canRead: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_READ),
    canRevokeBindings: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_DELETE),
    canTest: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_TEST),
    canUpdate: granted.has(PLATFORM_PERMISSIONS.CONNECTOR_UPDATE),
  };
};

export interface EditableAdminConnectorDraft {
  credentialMode: ConnectorCredentialMode;
  description: string;
  displayName: string;
  enabled: boolean;
  endpoint: string;
  oauthAuthorizationEndpoint: string;
  oauthClientId: string;
  oauthIssuer: string;
  oauthScopes: string;
  oauthTokenEndpoint: string;
  sort: number;
  tools: AdminConnectorToolDraft[];
}

export const toEditableAdminConnectorDraft = (
  draft: AdminConnectorDraft,
): EditableAdminConnectorDraft => ({
  credentialMode: draft.credentialMode,
  description: draft.description ?? '',
  displayName: draft.displayName,
  enabled: draft.enabled,
  endpoint: draft.endpoint,
  oauthAuthorizationEndpoint: draft.oauthConfig?.authorizationEndpoint ?? '',
  oauthClientId: draft.oauthConfig?.clientId ?? '',
  oauthIssuer: draft.oauthConfig?.issuer ?? '',
  oauthScopes: draft.oauthConfig?.scopes.join(' ') ?? '',
  oauthTokenEndpoint: draft.oauthConfig?.tokenEndpoint ?? '',
  sort: draft.sort,
  tools: draft.tools,
});

export type AdminConnectorDraftField = keyof EditableAdminConnectorDraft;

export interface AdminConnectorDraftValidation {
  errors: Partial<Record<AdminConnectorDraftField, string>>;
  valid: boolean;
}

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
};

export const validateEditableAdminConnectorDraft = (
  draft: EditableAdminConnectorDraft,
): AdminConnectorDraftValidation => {
  const errors: AdminConnectorDraftValidation['errors'] = {};
  if (!draft.displayName.trim()) errors.displayName = 'required';
  if (!isHttpUrl(draft.endpoint)) errors.endpoint = 'httpUrl';
  if (draft.credentialMode === 'per_user_oauth') {
    if (!isHttpUrl(draft.oauthAuthorizationEndpoint)) {
      errors.oauthAuthorizationEndpoint = 'httpUrl';
    }
    if (!draft.oauthClientId.trim()) errors.oauthClientId = 'required';
    if (!isHttpUrl(draft.oauthIssuer)) errors.oauthIssuer = 'httpUrl';
    if (!draft.oauthScopes.trim()) errors.oauthScopes = 'required';
    if (!isHttpUrl(draft.oauthTokenEndpoint)) errors.oauthTokenEndpoint = 'httpUrl';
  }
  return { errors, valid: Object.keys(errors).length === 0 };
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
};

/** Secret values never enter the public draft fingerprint or durable client storage. */
export const fingerprintEditableAdminConnectorDraft = (
  draft: EditableAdminConnectorDraft,
): string => JSON.stringify(canonicalize(draft));

export const fingerprintAdminConnectorSnapshot = (snapshot: AdminConnectorGetOutput): string =>
  JSON.stringify(
    canonicalize({
      baseRevision: snapshot.baseRevision,
      draft: fingerprintEditableAdminConnectorDraft(toEditableAdminConnectorDraft(snapshot.draft)),
      draftToken: snapshot.draftToken,
      publishedRevision: snapshot.published?.publishedRevision ?? null,
      secretState:
        snapshot.draft.credentialMode === 'shared_service_account'
          ? snapshot.draft.sharedSecret
          : snapshot.draft.credentialMode === 'per_user_oauth'
            ? snapshot.draft.oauthClientSecret
            : null,
    }),
  );

export type AdminConnectorPrimaryAction = 'none' | 'publish' | 'retry' | 'save' | 'test';

/** One dominant action for the sticky editor footer. */
export const resolveAdminConnectorPrimaryAction = (params: {
  canPublish: boolean;
  canSave: boolean;
  canTest: boolean;
  conflict: boolean;
  dirty: boolean;
  saveFailed: boolean;
  testPassed: boolean;
}): AdminConnectorPrimaryAction => {
  if (params.conflict) return 'none';
  if (params.saveFailed && params.canSave) return 'retry';
  if (params.dirty && params.canSave) return 'save';
  if (!params.testPassed && params.canTest) return 'test';
  if (params.testPassed && params.canPublish) return 'publish';
  return 'none';
};

export const isPersistedConnectorTestCurrent = (snapshot: AdminConnectorGetOutput): boolean => {
  const state = snapshot.draft.connectionTest;
  return Boolean(
    state &&
    state.status === 'success' &&
    !state.stale &&
    state.testedRevision === snapshot.baseRevision &&
    state.testedDraftToken === snapshot.draftToken,
  );
};

export const updateConnectorToolPolicy = (
  tools: AdminConnectorToolDraft[],
  toolId: string,
  patch: Partial<
    Pick<
      AdminConnectorToolDraft,
      'enabled' | 'platformPolicy' | 'requiresConfirmation' | 'riskLevel'
    >
  >,
): AdminConnectorToolDraft[] =>
  tools.map((tool) => (tool.id === toolId ? { ...tool, ...patch } : tool));
