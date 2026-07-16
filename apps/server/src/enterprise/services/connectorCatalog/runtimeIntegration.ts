import type { ToolManifest } from '@lobechat/types';

import { ConnectorModel } from '@/database/models/connector';
import { ConnectorToolModel } from '@/database/models/connectorTool';
import { PlatformManagedResourcePolicyModel } from '@/database/models/platform';
import {
  PlatformConnectorCatalogRepository,
  PlatformUserConnectorBindingRepository,
} from '@/database/repositories/platformConnectorCatalog';
import { ConnectorToolPermission } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { connectorOperationProofSchema } from '../../contracts/platformConnectors';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import { PlatformAuditService } from '../platformAudit';
import { ConnectorOutboundClient } from './connectorOutboundClient';
import { PlatformConnectorContractError } from './errors';
import { type ConnectorOAuthRuntimeEnv, getConnectorOAuthRuntime } from './oauthRuntime';
import {
  type ConnectorOperationProof,
  ConnectorOperationSnapshotService,
} from './operationSnapshot';
import { PlatformConnectorSecretStore } from './platformConnectorSecretStore';
import {
  BoundedConnectorRuntimeRateLimiter,
  PlatformConnectorRuntimeAdapter,
} from './runtimeAdapter';
import { resolveConnectorCatalogRuntimeReadiness } from './runtimeReadiness';
import { resolveConnectorConfirmationPolicy } from './toolPolicy';
import { UserConnectorOAuthService } from './userOAuthService';

type ConnectorRuntimeMode = 'blocked' | 'enforced' | 'legacy';

export interface PlatformConnectorRuntimeManifest extends ToolManifest {
  platformConnectorProof: ConnectorOperationProof;
}

export interface ManagedConnectorExecutionResult {
  handled: boolean;
  result?: {
    content: string;
    error?: { code: string; message: string };
    state?: Record<string, unknown>;
    success: boolean;
  };
}

const sharedRateLimiter = new BoundedConnectorRuntimeRateLimiter();

const stableFailure = (code: string): ManagedConnectorExecutionResult => ({
  handled: true,
  result: { content: code, error: { code, message: code }, success: false },
});

/** Prevent direct legacy MCP routes from bypassing the operation snapshot executor. */
export const assertLegacyConnectorRuntimeAllowed = async (params: {
  db: LobeChatDatabase;
  env?: ConnectorOAuthRuntimeEnv;
  identifier: string;
  userId: string;
  workspaceId?: string;
}): Promise<void> => {
  const mode = await resolveConnectorRuntimeMode(params);
  if (mode === 'legacy') return;
  if (mode === 'blocked') {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  const [platformConnector, legacyConnector] = await Promise.all([
    new PlatformConnectorCatalogRepository(params.db).getConnectorByKey(params.identifier),
    new ConnectorModel(params.db, params.userId, params.workspaceId).queryByIdentifiers([
      params.identifier,
    ]),
  ]);
  if (platformConnector || legacyConnector.length > 0) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TOOL_DENIED');
  }
};

/** Feature-off and non-enforced modes preserve legacy behavior without catalog runtime I/O. */
export const resolveConnectorRuntimeMode = async (params: {
  db: LobeChatDatabase;
  env?: ConnectorOAuthRuntimeEnv;
  policySnapshot?: () => Promise<
    Awaited<ReturnType<PlatformManagedResourcePolicyModel['getSnapshot']>>
  >;
  readiness?: () => Promise<boolean>;
}): Promise<ConnectorRuntimeMode> => {
  const env = params.env ?? process.env;
  const flags = parseEnterpriseFeatureFlags(env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) return 'legacy';

  const snapshot = await (
    params.policySnapshot ?? (() => new PlatformManagedResourcePolicyModel(params.db).getSnapshot())
  )();
  const policy = snapshot.status === 'published' ? snapshot.published.connectors : undefined;
  if (!policy?.managed || policy.enforcementMode !== 'enforced') return 'legacy';

  return (await (
    params.readiness ?? (() => resolveConnectorCatalogRuntimeReadiness({ db: params.db, env }))
  )())
    ? 'enforced'
    : 'blocked';
};

export const buildManagedConnectorManifests = async (params: {
  connectorKeys: string[];
  db: LobeChatDatabase;
  env?: ConnectorOAuthRuntimeEnv;
  operationId: string;
  userId: string;
  workspaceId?: string;
}): Promise<{ manifests: PlatformConnectorRuntimeManifest[]; mode: ConnectorRuntimeMode }> => {
  const mode = await resolveConnectorRuntimeMode(params);
  if (mode !== 'enforced') return { manifests: [], mode };

  const repository = new PlatformConnectorCatalogRepository(params.db);
  const snapshots = new ConnectorOperationSnapshotService(repository);
  const legacyConnectors = await new ConnectorModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryByIdentifiers(params.connectorKeys);
  const legacyByKey = new Map(
    legacyConnectors.map((connector) => [connector.identifier, connector]),
  );
  const legacyTools = await new ConnectorToolModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryAllByConnectorIds(legacyConnectors.map((connector) => connector.id));
  const legacyToolsByConnector = new Map<string, typeof legacyTools>();
  for (const tool of legacyTools) {
    const current = legacyToolsByConnector.get(tool.userConnectorId) ?? [];
    current.push(tool);
    legacyToolsByConnector.set(tool.userConnectorId, current);
  }

  const manifests: PlatformConnectorRuntimeManifest[] = [];
  for (const connectorKey of new Set(params.connectorKeys)) {
    let snapshot;
    try {
      snapshot = await snapshots.freezeCurrent({ connectorKey, operationId: params.operationId });
    } catch (error) {
      if (
        error instanceof PlatformConnectorContractError &&
        error.code === 'PLATFORM_CONNECTOR_NOT_PUBLISHED'
      ) {
        continue;
      }
      throw error;
    }
    const legacyConnector = legacyByKey.get(connectorKey);
    const permissionByTool = new Map(
      (legacyConnector ? (legacyToolsByConnector.get(legacyConnector.id) ?? []) : []).map(
        (tool) => [tool.toolName, tool.permission],
      ),
    );
    const api = snapshot.payload.tools
      .filter((tool) => tool.platformPolicy === 'allow')
      .filter((tool) => permissionByTool.get(tool.toolKey) !== ConnectorToolPermission.disabled)
      .map((tool) => {
        const humanIntervention = resolveConnectorConfirmationPolicy({
          legacyRequiresConfirmation:
            permissionByTool.get(tool.toolKey) === ConnectorToolPermission.needs_approval,
          requiresConfirmation: tool.requiresConfirmation,
          riskLevel: tool.riskLevel,
        });
        return {
          description: tool.description ?? '',
          ...(humanIntervention ? { humanIntervention } : {}),
          name: tool.toolKey,
          parameters: tool.inputSchema,
        };
      });
    manifests.push({
      api,
      identifier: connectorKey,
      meta: {
        avatar: 'MCP_AVATAR',
        description: snapshot.payload.connector.description ?? undefined,
        title: snapshot.payload.connector.displayName,
      },
      platformConnectorProof: snapshot.proof,
      type: 'mcp',
    });
  }
  return { manifests, mode };
};

export const executeManagedConnectorTool = async (params: {
  agentId?: string;
  apiName: string;
  arguments: string | Record<string, unknown>;
  db?: LobeChatDatabase;
  env?: ConnectorOAuthRuntimeEnv;
  humanApproved?: boolean;
  identifier: string;
  manifest?: ToolManifest;
  operationId?: string;
  userId?: string;
  workspaceId?: string;
}): Promise<ManagedConnectorExecutionResult> => {
  const flags = parseEnterpriseFeatureFlags(params.env ?? process.env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS || !params.db) return { handled: false };

  try {
    const mode = await resolveConnectorRuntimeMode({ db: params.db, env: params.env });
    if (mode === 'legacy') return { handled: false };
    if (mode === 'blocked') return stableFailure('PLATFORM_CONNECTOR_NOT_PUBLISHED');

    const rawProof = (params.manifest as Partial<PlatformConnectorRuntimeManifest> | undefined)
      ?.platformConnectorProof;
    const proof = connectorOperationProofSchema.safeParse(rawProof);
    if (!proof.success) {
      const [platformConnector, legacyConnector] = await Promise.all([
        new PlatformConnectorCatalogRepository(params.db).getConnectorByKey(params.identifier),
        params.userId
          ? new ConnectorModel(params.db, params.userId, params.workspaceId).queryByIdentifiers([
              params.identifier,
            ])
          : Promise.resolve([]),
      ]);
      return platformConnector || legacyConnector.length > 0
        ? stableFailure('PLATFORM_CONNECTOR_TOOL_DENIED')
        : { handled: false };
    }
    if (
      !params.userId ||
      !params.agentId ||
      !params.operationId ||
      proof.data.operationId !== params.operationId
    ) {
      return stableFailure('PLATFORM_CONNECTOR_TOOL_DENIED');
    }

    const repository = new PlatformConnectorCatalogRepository(params.db);
    const snapshots = new ConnectorOperationSnapshotService(repository);
    const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise(
      params.env ?? process.env,
      flags,
    );
    if (!secretService) return stableFailure('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    const secrets = new PlatformConnectorSecretStore(params.db, secretService);
    const outbound = new ConnectorOutboundClient(new SafeOutboundHttpClient());
    const adapter = new PlatformConnectorRuntimeAdapter({
      audit: {
        appendSharedCall: async (entry) => {
          try {
            await new PlatformAuditService(params.db!).append({
              action: 'connector.runtime.sharedCall',
              actorUserId: entry.userId,
              afterDiff: {
                connectorId: entry.connectorId,
                operationId: entry.operationId,
                outcome: entry.outcome,
                toolKey: entry.toolKey,
              },
              reason: null,
              result:
                entry.outcome === 'allowed'
                  ? 'success'
                  : entry.outcome === 'denied'
                    ? 'denied'
                    : 'failure',
              targetId: entry.connectorId,
              targetType: 'connector',
            });
          } catch (error) {
            console.error('[connector-runtime] audit append failed', {
              errorClass: error instanceof Error ? error.name : 'UnknownError',
            });
          }
        },
      },
      bindingLoader: (userId, connectorId) =>
        new PlatformUserConnectorBindingRepository(params.db!, userId).getBinding(connectorId),
      outbound,
      policy: {
        resolve: async ({ connectorKey, toolKey, userId }) => {
          const permission = await resolveLegacyPermission({
            connectorKey,
            db: params.db!,
            toolKey,
            userId,
            workspaceId: params.workspaceId,
          });
          return {
            agentAllowed: true,
            legacyRequiresConfirmation: permission === ConnectorToolPermission.needs_approval,
            userEnabled: permission !== ConnectorToolPermission.disabled,
          };
        },
      },
      rateLimiter: sharedRateLimiter,
      refreshBinding: async (userId, connectorId) => {
        const runtime = getConnectorOAuthRuntime(params.db!, params.env ?? process.env);
        await new UserConnectorOAuthService(params.db!, userId, runtime).refreshBinding(
          connectorId,
        );
      },
      secrets,
      snapshots,
    });
    const result = await adapter.execute({
      agentId: params.agentId,
      arguments: params.arguments,
      humanApproved: params.humanApproved === true,
      proof: proof.data,
      toolKey: params.apiName,
      userId: params.userId,
    });
    return {
      handled: true,
      result: { content: result.content, state: result.state, success: true },
    };
  } catch (error) {
    const code =
      error instanceof PlatformConnectorContractError
        ? error.code
        : 'PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED';
    return stableFailure(code);
  }
};

const resolveLegacyPermission = async (params: {
  connectorKey: string;
  db: LobeChatDatabase;
  toolKey: string;
  userId: string;
  workspaceId?: string;
}) => {
  const [connector] = await new ConnectorModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryByIdentifiers([params.connectorKey]);
  if (!connector) return null;
  const tools = await new ConnectorToolModel(
    params.db,
    params.userId,
    params.workspaceId,
  ).queryByConnector(connector.id);
  return tools.find((tool) => tool.toolName === params.toolKey)?.permission ?? null;
};
