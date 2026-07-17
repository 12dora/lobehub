import { TRPCError } from '@trpc/server';
import { ZodError } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  collectConnectorSecretLeaves,
  connectorSharedCredentialSchema,
  PlatformConnectorContractError,
} from '../../contracts/platformConnectors';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { assertRecentReauth } from '../../guards/reauth';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretError, PlatformSecretService } from '../../security/secret';
import { ConnectorCatalogService } from '../../services/connectorCatalog/catalogService';
import type {
  ConnectorCatalogCredentialProvider,
  ConnectorCatalogSecretStore,
} from '../../services/connectorCatalog/catalogTypes';
import { ConnectorOutboundClient } from '../../services/connectorCatalog/connectorOutboundClient';
import { PlatformConnectorSecretStore } from '../../services/connectorCatalog/platformConnectorSecretStore';
import { assertConnectorPersistentTextSafe } from '../../services/connectorCatalog/secretBoundary';
import { PlatformAuditService } from '../../services/platformAudit';
import { getPlatformConfigInvalidationPublisher } from '../../services/platformConfigInvalidation';

const OPERATION_FAILED = 'PLATFORM_CONNECTOR_OPERATION_FAILED';

const resolveRedirectUri = (env: Record<string, string | undefined>): string => {
  const appUrl = env.APP_URL?.trim();
  if (!appUrl) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  try {
    const parsed = new URL(appUrl);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('invalid app URL');
    }
    return new URL('/oauth/connector/callback', parsed).toString();
  } catch {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
};

const toCredentialHeaders = (value: unknown): Record<string, string> => {
  const credential = connectorSharedCredentialSchema.parse(value);
  const candidate = {
    ...credential.headers,
    ...(credential.apiKey ? { Authorization: `Bearer ${credential.apiKey}` } : {}),
    ...(credential.bearerToken ? { Authorization: `Bearer ${credential.bearerToken}` } : {}),
    ...(credential.username && credential.password
      ? {
          Authorization: `Basic ${Buffer.from(
            `${credential.username}:${credential.password}`,
          ).toString('base64')}`,
        }
      : {}),
  };
  if (Object.keys(candidate).length === 0) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  try {
    return Object.fromEntries(new Headers(candidate).entries());
  } catch {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
};

const createCredentialProvider = (
  secrets: ConnectorCatalogSecretStore,
): ConnectorCatalogCredentialProvider => ({
  getHeaders: async ({ connectorId, credentialMode }) => {
    if (credentialMode === 'none') return {};
    if (credentialMode !== 'shared_service_account') {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
    try {
      const sources = await secrets.loadCurrentSecretSources(connectorId);
      return toCredentialHeaders(sources.sharedSecret);
    } catch (error) {
      if (error instanceof PlatformConnectorContractError) throw error;
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
  },
});

export interface AdminConnectorRuntime {
  secrets: ConnectorCatalogSecretStore;
  service: ConnectorCatalogService;
}

export const createAdminConnectorRuntime = (
  db: LobeChatDatabase,
  env: Record<string, string | undefined> = process.env,
): AdminConnectorRuntime => {
  const flags = parseEnterpriseFeatureFlags(env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
    });
  }
  let secretService: PlatformSecretService | null;
  try {
    secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise(env, flags);
  } catch {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
    });
  }
  if (!secretService) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
    });
  }
  const secrets = new PlatformConnectorSecretStore(db, secretService);
  return {
    secrets,
    service: new ConnectorCatalogService(
      db,
      new ConnectorOutboundClient(new SafeOutboundHttpClient()),
      secrets,
      {
        credentials: createCredentialProvider(secrets),
        invalidation: getPlatformConfigInvalidationPublisher(),
        redirectUri: resolveRedirectUri(env),
      },
    ),
  };
};

const connectorErrorHttpCode = (
  code: PlatformConnectorContractError['code'],
): ConstructorParameters<typeof TRPCError>[0]['code'] => {
  if (code === 'PLATFORM_CONNECTOR_NOT_FOUND') return 'NOT_FOUND';
  if (
    code === 'PLATFORM_CONNECTOR_RESOURCE_MISMATCH' ||
    code === 'PLATFORM_CONNECTOR_BINDING_OWNERSHIP_MISMATCH'
  ) {
    return 'CONFLICT';
  }
  if (
    code === 'PLATFORM_CONNECTOR_NOT_PUBLISHED' ||
    code === 'PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED'
  ) {
    return 'PRECONDITION_FAILED';
  }
  if (
    code === 'PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED' ||
    code === 'PLATFORM_CONNECTOR_SSRF_BLOCKED' ||
    code === 'PLATFORM_CONNECTOR_TOOL_DENIED'
  ) {
    return 'FORBIDDEN';
  }
  return 'BAD_REQUEST';
};

/** Transport boundary: only stable codes and error classes may leave this module. */
export const executeAdminConnectorOperation = async <T>(
  action: string,
  operation: () => Promise<T>,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof PlatformRevisionConflictError) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      });
    }
    if (error instanceof PlatformConnectorContractError) {
      throw new TRPCError({ code: connectorErrorHttpCode(error.code), message: error.code });
    }
    if (error instanceof ZodError) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      });
    }
    if (error instanceof PlatformSecretError) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
      });
    }
    console.error('[admin.connectors] operation failed', {
      action,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: OPERATION_FAILED });
  }
};

export const connectorSecretMutationRequiresReauth = (
  mutation: { operation: 'clear' | 'keep' | 'replace' } | undefined,
): boolean => mutation?.operation === 'clear' || mutation?.operation === 'replace';

export const assertConnectorDangerousReauth = async (params: {
  action: string;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertRecentReauth>[0]['authMethod'];
  reason: string;
  replacementSecrets?: unknown[];
  runtime: AdminConnectorRuntime;
  serverDB: LobeChatDatabase;
  targetId: string;
}) => {
  try {
    assertRecentReauth({
      authenticatedAt: params.authenticatedAt,
      authMethod: params.authMethod,
    });
  } catch (error) {
    let safeReason: string | null = null;
    try {
      const current = await params.runtime.secrets.loadCurrentSecretSources(params.targetId);
      safeReason = assertConnectorPersistentTextSafe(
        params.reason,
        collectConnectorSecretLeaves(
          current.oauthClientSecret,
          current.sharedSecret,
          ...(params.replacementSecrets ?? []),
        ),
      );
    } catch {
      // A denied action must never persist a reason that could contain an unknown Secret.
    }
    try {
      await new PlatformAuditService(params.serverDB).append({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: { error: 'reauth_required' },
        reason: safeReason,
        result: 'denied',
        targetId: params.targetId,
        targetType: 'connector',
      });
    } catch (auditError) {
      console.error('[admin.connectors] reauth denied audit failed', {
        action: params.action,
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    throw error;
  }
};
