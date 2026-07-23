import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import type {
  AdminConnectorDraft,
  AdminConnectorGetOutput,
  AdminConnectorToolDraft,
  AdminConnectorUpdateDraftInput,
  ConnectorCredentialMode,
} from './types';

export interface AdminConnectorPermissions {
  canArchive: boolean;
  canCreate: boolean;
  canDelete: boolean;
  canDiscover: boolean;
  canPublish: boolean;
  canRead: boolean;
  canReadAudit: boolean;
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
    canReadAudit: granted.has(PLATFORM_PERMISSIONS.AUDIT_READ),
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

export type ConnectorSecretEdit =
  | { operation: 'clear'; value: '' }
  | { operation: 'keep'; value: '' }
  | { operation: 'replace'; value: string };

export const createEmptyConnectorSecretEdit = (): ConnectorSecretEdit => ({
  operation: 'keep',
  value: '',
});

export const updateConnectorSecretEdit = (value: string): ConnectorSecretEdit =>
  value ? { operation: 'replace', value } : createEmptyConnectorSecretEdit();

export const clearConnectorSecretEdit = (): ConnectorSecretEdit => ({
  operation: 'clear',
  value: '',
});

export const changeConnectorCredentialMode = (
  draft: EditableAdminConnectorDraft,
  credentialMode: ConnectorCredentialMode,
): EditableAdminConnectorDraft => ({ ...draft, credentialMode });

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

/** Session-retained success from the last connection test in this editor. */
export interface SessionConnectorTestResult {
  status: 'success';
  testedDraftToken: string;
  testedRevision: number;
}

export const isPersistedConnectorTestCurrent = (
  snapshot: AdminConnectorGetOutput,
  sessionTest?: SessionConnectorTestResult | null,
): boolean => {
  if (
    sessionTest &&
    sessionTest.status === 'success' &&
    sessionTest.testedRevision === snapshot.baseRevision &&
    sessionTest.testedDraftToken === snapshot.draftToken
  ) {
    return true;
  }
  const state = snapshot.draft.connectionTest;
  return Boolean(
    state &&
    state.status === 'success' &&
    !state.stale &&
    state.testedRevision === snapshot.baseRevision &&
    state.testedDraftToken === snapshot.draftToken,
  );
};

export type ConnectorRollbackTargetError = 'currentRevision' | 'positiveInteger' | null;

export const validateConnectorRollbackTarget = (
  targetRevision: number | null,
  currentRevision: number,
): ConnectorRollbackTargetError => {
  if (targetRevision === null || !Number.isInteger(targetRevision) || targetRevision <= 0) {
    return 'positiveInteger';
  }
  if (targetRevision === currentRevision) return 'currentRevision';
  return null;
};

export const updateConnectorToolPolicy = (
  tools: AdminConnectorToolDraft[],
  toolId: string,
  patch: Partial<
    Pick<
      AdminConnectorToolDraft,
      'enabled' | 'platformPolicy' | 'requiresConfirmation' | 'riskLevel' | 'sort'
    >
  >,
): AdminConnectorToolDraft[] =>
  sortConnectorTools(
    tools.map((tool) => {
      if (tool.id !== toolId) return tool;
      const next = {
        ...tool,
        ...patch,
        sort: Number.isInteger(patch.sort) ? patch.sort! : tool.sort,
      };
      return next.riskLevel === 'critical' || next.riskLevel === 'high'
        ? { ...next, requiresConfirmation: true }
        : next;
    }),
  );

export const sortConnectorTools = (tools: AdminConnectorToolDraft[]): AdminConnectorToolDraft[] =>
  [...tools].sort(
    (left, right) =>
      left.sort - right.sort ||
      left.toolKey.localeCompare(right.toolKey) ||
      left.id.localeCompare(right.id),
  );

export const normalizeConnectorTools = (
  tools: AdminConnectorToolDraft[],
): AdminConnectorToolDraft[] =>
  sortConnectorTools(
    tools.map((tool) =>
      tool.riskLevel === 'critical' || tool.riskLevel === 'high'
        ? { ...tool, requiresConfirmation: true }
        : tool,
    ),
  );

export const buildConnectorUpdatePayload = (params: {
  draft: EditableAdminConnectorDraft;
  reason: string;
  secret: ConnectorSecretEdit;
  snapshot: AdminConnectorGetOutput;
}): AdminConnectorUpdateDraftInput => {
  const common = {
    credentialMode: params.draft.credentialMode,
    description: params.draft.description.trim() || null,
    displayName: params.draft.displayName.trim(),
    enabled: params.draft.enabled,
    endpoint: params.draft.endpoint.trim(),
    expectedDraftToken: params.snapshot.draftToken,
    expectedRevision: params.snapshot.baseRevision,
    id: params.snapshot.draft.id,
    reason: params.reason,
    sort: params.draft.sort,
    tools: normalizeConnectorTools(params.draft.tools),
  };
  if (params.draft.credentialMode === 'per_user_oauth') {
    return {
      ...common,
      oauthClientSecret:
        params.secret.operation === 'replace'
          ? { operation: 'replace', value: params.secret.value }
          : { operation: params.secret.operation },
      oauthConfig: {
        authorizationEndpoint: params.draft.oauthAuthorizationEndpoint.trim(),
        clientId: params.draft.oauthClientId.trim(),
        issuer: params.draft.oauthIssuer.trim(),
        scopes: params.draft.oauthScopes.split(/\s+/).filter(Boolean),
        tokenEndpoint: params.draft.oauthTokenEndpoint.trim(),
      },
    };
  }
  if (params.draft.credentialMode === 'shared_service_account') {
    return {
      ...common,
      oauthConfig: null,
      sharedSecret:
        params.secret.operation === 'replace'
          ? { operation: 'replace', value: { bearerToken: params.secret.value } }
          : { operation: params.secret.operation },
    };
  }
  return { ...common, oauthConfig: null };
};
