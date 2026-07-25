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
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import type { OutboundPolicySnapshot } from '../../security/outboundHttp';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretError, PlatformSecretService } from '../../security/secret';
import type { AuditAction } from '../../services/audit/auditActionCatalog';
import { ConnectorCatalogService } from '../../services/connectorCatalog/catalogService';
import type {
  ConnectorCatalogCredentialProvider,
  ConnectorCatalogSecretStore,
} from '../../services/connectorCatalog/catalogTypes';
import {
  canonicalConnectorAppUrlProvider,
  type ConnectorAppUrlProvider,
  resolveConnectorCallbackRedirectUri,
} from '../../services/connectorCatalog/connectorCallbackRedirect';
import { ConnectorOutboundClient } from '../../services/connectorCatalog/connectorOutboundClient';
import { connectorOutboundPolicyProvider } from '../../services/connectorCatalog/connectorOutboundPolicy';
import { PlatformConnectorSecretStore } from '../../services/connectorCatalog/platformConnectorSecretStore';
import { assertConnectorPersistentTextSafe } from '../../services/connectorCatalog/secretBoundary';
import { PlatformAuditService } from '../../services/platformAudit';
import { getPlatformConfigInvalidationPublisher } from '../../services/platformConfigInvalidation';

const OPERATION_FAILED = 'PLATFORM_CONNECTOR_OPERATION_FAILED';

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
  assertOutboundPolicyReady: () => void;
  resolveRedirectUri: () => string;
  secrets: ConnectorCatalogSecretStore;
  service: ConnectorCatalogService;
}

export interface AdminConnectorRuntimeOptions {
  appUrlProvider?: ConnectorAppUrlProvider;
  env?: Record<string, string | undefined>;
  outboundPolicyProvider?: () => OutboundPolicySnapshot;
}

export const createAdminConnectorRuntime = (
  db: LobeChatDatabase,
  options: AdminConnectorRuntimeOptions = {},
): AdminConnectorRuntime => {
  const env = options.env ?? process.env;
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
  const appUrlProvider = options.appUrlProvider ?? canonicalConnectorAppUrlProvider;
  const outbound = new ConnectorOutboundClient(
    new SafeOutboundHttpClient({
      policyProvider: options.outboundPolicyProvider ?? connectorOutboundPolicyProvider,
    }),
  );
  const resolveRedirectUri = () => resolveConnectorCallbackRedirectUri(appUrlProvider);
  return {
    assertOutboundPolicyReady: () => {
      outbound.getPolicyVersion();
    },
    resolveRedirectUri,
    secrets,
    service: new ConnectorCatalogService(db, outbound, secrets, {
      credentials: createCredentialProvider(secrets),
      invalidation: getPlatformConfigInvalidationPublisher(),
      redirectUri: resolveRedirectUri,
    }),
  };
};

/**
 * Connector list/get/published-batch reads are pure projections of persisted catalog rows and never
 * resolve platform secrets (only publish/discover/test do). This null-object satisfies the
 * `ConnectorCatalogService` secret contract so those reads can run without a PLATFORM_MASTER_KEY /
 * Vault — which the full secret runtime (`createAdminConnectorRuntime`) hard-requires. Reaching any
 * method here means a read path unexpectedly touched a secret, so every method fails closed.
 */
const readOnlyConnectorSecretStore: ConnectorCatalogSecretStore = {
  loadCurrentSecretSources: () => {
    throw new PlatformSecretError(
      PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
      'connector read runtime does not resolve secrets',
    );
  },
  persistSecret: () => {
    throw new PlatformSecretError(
      PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
      'connector read runtime does not resolve secrets',
    );
  },
  resolveSecretRef: () => {
    throw new PlatformSecretError(
      PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
      'connector read runtime does not resolve secrets',
    );
  },
  resolveSecretVersion: () => {
    throw new PlatformSecretError(
      PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
      'connector read runtime does not resolve secrets',
    );
  },
};

export interface AdminConnectorReadRuntime {
  service: ConnectorCatalogService;
}

/**
 * Secret-free read runtime for admin connector list / get / published-batch projections.
 * Keeps the `ENABLE_PLATFORM_MANAGED_CONNECTORS` feature gate but skips secret-service creation, so
 * an instance without a platform master key can still browse the org connector catalog. NEVER use
 * this for mutations — secret-touching operations must go through `createAdminConnectorRuntime`.
 */
export const createAdminConnectorReadRuntime = (
  db: LobeChatDatabase,
  options: AdminConnectorRuntimeOptions = {},
): AdminConnectorReadRuntime => {
  const env = options.env ?? process.env;
  const flags = parseEnterpriseFeatureFlags(env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
    });
  }
  const outbound = new ConnectorOutboundClient(
    new SafeOutboundHttpClient({
      policyProvider: options.outboundPolicyProvider ?? connectorOutboundPolicyProvider,
    }),
  );
  return {
    service: new ConnectorCatalogService(db, outbound, readOnlyConnectorSecretStore, {
      redirectUri: () => undefined,
    }),
  };
};

export type AdminConnectorFactoryFailureCategory =
  'feature_disabled' | 'redirect_unavailable' | 'secret_unavailable' | 'transport_unavailable';

const FACTORY_FAILURE_REASON = 'connector factory dependency unavailable';

const sanitizeFactoryFailureReason = async (params: {
  reason: string;
  replacementSecrets?: unknown[];
  runtime?: AdminConnectorRuntime;
  targetId: string;
}): Promise<string> => {
  if (!params.runtime) return FACTORY_FAILURE_REASON;
  try {
    const current = await params.runtime.secrets.loadCurrentSecretSources(params.targetId);
    return assertConnectorPersistentTextSafe(
      params.reason,
      collectConnectorSecretLeaves(
        current.oauthClientSecret,
        current.sharedSecret,
        ...(params.replacementSecrets ?? []),
      ),
    );
  } catch {
    return FACTORY_FAILURE_REASON;
  }
};

const appendFactoryFailureAudit = async (params: {
  action: AuditAction;
  actorUserId: string;
  category: AdminConnectorFactoryFailureCategory;
  reason: string;
  replacementSecrets?: unknown[];
  runtime?: AdminConnectorRuntime;
  serverDB: LobeChatDatabase;
  targetId: string;
}): Promise<void> => {
  try {
    await new PlatformAuditService(params.serverDB).append({
      action: params.action,
      actorUserId: params.actorUserId,
      afterDiff: { category: params.category, error: 'factory_dependency_unavailable' },
      reason: await sanitizeFactoryFailureReason(params),
      result: 'failure',
      targetId: params.targetId,
      targetType: 'connector',
    });
  } catch (auditError) {
    console.error('[admin.connectors] factory failure audit failed', {
      action: params.action,
      errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
    });
  }
};

const inferRuntimeFactoryFailureCategory = (
  error: unknown,
): AdminConnectorFactoryFailureCategory =>
  error instanceof TRPCError && error.message === PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED
    ? 'feature_disabled'
    : 'secret_unavailable';

export const resolveAdminConnectorMutationRuntime = async (params: {
  action: AuditAction;
  actorUserId: string;
  createRuntime: () => AdminConnectorRuntime;
  reason: string;
  replacementSecrets?: unknown[];
  serverDB: LobeChatDatabase;
  targetId: string;
}): Promise<AdminConnectorRuntime> => {
  try {
    return params.createRuntime();
  } catch (error) {
    await appendFactoryFailureAudit({
      ...params,
      category: inferRuntimeFactoryFailureCategory(error),
    });
    throw error;
  }
};

export const assertAdminConnectorRuntimeDependency = async (params: {
  action: AuditAction;
  actorUserId: string;
  category: Extract<
    AdminConnectorFactoryFailureCategory,
    'redirect_unavailable' | 'transport_unavailable'
  >;
  operation: () => void;
  reason: string;
  replacementSecrets?: unknown[];
  runtime: AdminConnectorRuntime;
  serverDB: LobeChatDatabase;
  targetId: string;
}): Promise<void> => {
  try {
    params.operation();
  } catch (error) {
    await appendFactoryFailureAudit(params);
    throw error;
  }
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

/** Transport boundary: only stable codes and error classes may leave this module.
 *  `action` is an operation path for error logs — not necessarily an audit-catalog token.
 */
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
    // applyImmediate hard-fail on published update: surface human-safe publishError (never secrets).
    if (error instanceof Error && error.name === 'ConnectorPublishImmediateError') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: error.message.slice(0, 500),
      });
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
  action: AuditAction;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  reason: string;
  replacementSecrets?: unknown[];
  runtime: AdminConnectorRuntime;
  serverDB: LobeChatDatabase;
  targetId: string;
}) =>
  assertDangerousReauthWithAudit({
    authenticatedAt: params.authenticatedAt,
    authMethod: params.authMethod,
    serverDB: params.serverDB,
    denied: {
      action: params.action,
      actorUserId: params.actorUserId,
      resolveDeniedReason: async () => {
        try {
          const current = await params.runtime.secrets.loadCurrentSecretSources(params.targetId);
          return assertConnectorPersistentTextSafe(
            params.reason,
            collectConnectorSecretLeaves(
              current.oauthClientSecret,
              current.sharedSecret,
              ...(params.replacementSecrets ?? []),
            ),
          );
        } catch {
          // A denied action must never persist a reason that could contain an unknown Secret.
          return null;
        }
      },
      targetId: params.targetId,
      targetType: 'connector',
    },
  });
