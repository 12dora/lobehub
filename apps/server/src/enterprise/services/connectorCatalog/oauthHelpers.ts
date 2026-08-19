import { createHash } from 'node:crypto';

import type {
  PlatformConnectorOAuthStateItem,
  PlatformUserConnectorBindingItem,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { connectorBindingSchema, connectorScopesSchema } from '../../contracts/platformConnectors';
import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import { PlatformConnectorContractError } from './errors';
import type { ConnectorOAuthRuntimeDependencies } from './oauthRuntime';
import { cleanupConnectorSecretRefs } from './secretCleanup';

type PublishedPerUserOAuthErrorCode =
  'PLATFORM_CONNECTOR_NOT_PUBLISHED' | 'PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID';

export const hashOAuthValue = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const createPkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

export const assertStoredSecret = (value: { fingerprint: string; ref: string }) => {
  if (
    value.fingerprint.length === 0 ||
    (!value.ref.startsWith('vault://') && !value.ref.startsWith('kms://'))
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  return value;
};

export const assertExactAuthorizationEndpoint = (value: string): URL => {
  const url = new URL(value);
  const reserved = [
    'client_id',
    'code_challenge',
    'code_challenge_method',
    'redirect_uri',
    'response_type',
    'scope',
    'state',
  ];
  if (url.hash || reserved.some((key) => url.searchParams.has(key))) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_OAUTH_CALLBACK_INVALID');
  }
  return url;
};

export const parseGrantedScopes = (scope: string | undefined, requested: string[]): string[] => {
  if (!scope) return [...requested];
  const scopes = connectorScopesSchema.parse(scope.split(/\s+/u).filter(Boolean));
  const requestedSet = new Set(requested);
  if (scopes.some((candidate) => !requestedSet.has(candidate))) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SCOPE_NOT_ALLOWED');
  }
  return scopes;
};

export const bestEffortRevokeSecret = (
  dependencies: ConnectorOAuthRuntimeDependencies,
  connectorId: string,
  slot: 'oauthBindingToken' | 'oauthPkceVerifier',
  ref: string | null | undefined,
  db?: LobeChatDatabase,
): Promise<void> =>
  ref
    ? cleanupConnectorSecretRefs(dependencies.secrets, [{ connectorId, ref, slot }], { db })
    : Promise.resolve();

export const appendOAuthAuditBestEffort = async (
  db: LobeChatDatabase,
  params: {
    action: AuditAction;
    actorUserId: string;
    status: string;
    targetId: string;
  },
): Promise<void> => {
  try {
    await new PlatformAuditService(db).append({
      action: params.action,
      actorUserId: params.actorUserId,
      afterDiff: { status: params.status },
      reason: null,
      result: 'success',
      targetId: params.targetId,
      targetType: 'connector_binding',
    });
  } catch (error) {
    console.error('[connectorOAuth] audit append failed', {
      action: params.action,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
  }
};

export const toBindingProjection = (binding: PlatformUserConnectorBindingItem | undefined) =>
  binding
    ? connectorBindingSchema.parse({
        connectedAt: binding.connectedAt,
        expiresAt: binding.expiresAt,
        id: binding.id,
        lastErrorCategory: binding.lastErrorCategory,
        scopes: binding.scopes,
        status: binding.status,
        updatedAt: binding.updatedAt,
      })
    : null;

export const assertPublishedPerUserOAuthConnector = <T>(params: {
  code: PublishedPerUserOAuthErrorCode;
  connector: { credentialMode: string; enabled: boolean };
  current:
    { enabled: boolean; publishedRevision: number | null; status: string } | null | undefined;
  expectedRevision: number;
  oauth: T;
}): NonNullable<T> => {
  if (
    !params.current ||
    params.current.status !== 'published' ||
    !params.current.enabled ||
    params.current.publishedRevision !== params.expectedRevision ||
    !params.connector.enabled ||
    params.connector.credentialMode !== 'per_user_oauth' ||
    !params.oauth
  ) {
    throw new PlatformConnectorContractError(params.code);
  }
  return params.oauth;
};

export const deriveAuthorizationAttemptStatus = (params: {
  binding: PlatformUserConnectorBindingItem;
  now: Date;
  state: PlatformConnectorOAuthStateItem;
}): {
  binding: ReturnType<typeof toBindingProjection>;
  status: 'completed' | 'superseded' | 'expired' | 'failed' | 'pending';
} => {
  const { binding, now, state } = params;
  const expired = !state.authorizationOutcome && state.expiresAt.getTime() <= now.getTime();
  const completed =
    !state.revokedAt &&
    state.authorizationOutcome === 'completed' &&
    binding.status === 'connected' &&
    !binding.revokedAt;
  return {
    binding: completed ? toBindingProjection(binding) : null,
    status: completed
      ? 'completed'
      : state.revokedAt
        ? 'superseded'
        : expired
          ? 'expired'
          : state.authorizationOutcome === 'failed'
            ? 'failed'
            : 'pending',
  };
};

export const applyAuthorizationQuery = (
  authorizationUrl: URL,
  params: {
    challenge: string;
    oauth: { clientId: string; redirectUri: string; scopes: string[] };
    state: string;
  },
): void => {
  authorizationUrl.searchParams.set('client_id', params.oauth.clientId);
  authorizationUrl.searchParams.set('code_challenge', params.challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('redirect_uri', params.oauth.redirectUri);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('scope', params.oauth.scopes.join(' '));
  authorizationUrl.searchParams.set('state', params.state);
};
