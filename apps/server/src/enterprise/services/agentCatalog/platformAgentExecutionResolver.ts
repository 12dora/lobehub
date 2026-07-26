/**
 * Fork-owned platform Agent execution seam.
 *
 * Keeps identity decoding, entitlement, resume-pin binding, materialization, and managed
 * runtime policy out of the upstream AiAgentService body so rebases only touch a thin adapter.
 */
import { LobeActivatorIdentifier } from '@lobechat/builtin-tool-activator';
import { SkillsIdentifier } from '@lobechat/builtin-tool-skills';
import { INBOX_SESSION_ID } from '@lobechat/const';
import type { LobeChatDatabase } from '@lobechat/database';
import type {
  PlatformAgentConnectorDependencyRef,
  PlatformAgentSkillDependencyRef,
  PlatformOperationModelPin,
  PlatformOperationPin,
  ResumeInteractionKind,
} from '@lobechat/types';
import { decodePlatformAgentListId, fingerprintResumeToolCall } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import debug from 'debug';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { AgentModel } from '@/database/models/agent';
import type { AgentOperationModel } from '@/database/models/agentOperation';
import type { MessageModel } from '@/database/models/message';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import { parseEnterpriseFeatureFlags } from '@/server/enterprise/featureFlags';
import { throwEnterpriseError } from '@/server/enterprise/guards/enterpriseErrors';
import type { AgentConfigWithId } from '@/server/services/agent';

import { PlatformDefaultInboxService } from './defaultInbox';
import { validateExactPlatformAgentDependencies } from './dependencyValidator';
import {
  PlatformAgentEffectiveResolver,
  type PlatformAgentOperationHandle,
} from './effectiveResolver';
import {
  PlatformAgentDependencyValidationError,
  PlatformAgentMaterializationError,
  PlatformAgentNotFoundError,
} from './errors';
import { PlatformAgentMaterializationService } from './materialization';

const log = debug('lobe-server:platform-agent-execution');

const throwAgentUnavailable = (): never =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_AGENT_UNAVAILABLE,
    httpCode: 'NOT_FOUND',
  });

/** Audited builtins allowed under a managed platform operation (exact allowlist). */
export const PLATFORM_AUDITED_BUILTIN_TOOL_IDS = [
  LobeActivatorIdentifier,
  SkillsIdentifier,
] as const;

/** Immutable execution plan returned once per managed operation start/resume. */
export interface PlatformAgentExecutionPlan {
  config: AgentConfigWithId;
  connectorRefs: PlatformAgentConnectorDependencyRef[];
  modelPin: PlatformOperationModelPin;
  pin: PlatformOperationPin;
  /**
   * Managed runtime policy — consumers should read these flags instead of scattering
   * `if (platformOperationPin)` conditionals for tool/skill composition.
   */
  policy: {
    allowBuiltinRuntimeMerge: false;
    allowDeviceTools: false;
    allowGlobalMemory: false;
    allowInstructions: false;
    allowLocalSystem: false;
    allowModelOverride: false;
    allowPluginInjection: false;
    allowRemoteDevice: false;
    exactBuiltinToolIds: readonly string[];
    managedPluginIds: readonly string[];
  };
  skillRefs: PlatformAgentSkillDependencyRef[];
}

export interface PlatformAgentIdentityResolution {
  capturedResumePin?: PlatformOperationPin;
  existingAgentId?: string;
  handle?: PlatformAgentOperationHandle;
  platformAgentId: string;
}

type EffectiveResolverSurface = Pick<
  PlatformAgentEffectiveResolver,
  'beginOperation' | 'isEntitled'
>;
type MaterializationSurface = Pick<
  PlatformAgentMaterializationService,
  | 'materializeForOperation'
  | 'materializeFromPin'
  | 'resolveForExistingAgent'
  | 'resolveFromPinForExistingAgent'
>;

export interface PlatformAgentExecutionResolverDeps {
  agentModel: Pick<AgentModel, 'getBuiltinAgent' | 'getAgentConfigById'>;
  agentOperationModel: Pick<AgentOperationModel, 'findResumablePlatformOperationPin'>;
  /**
   * Injectable so AiAgentService can pass barrel-imported constructors — unit tests that mock
   * `@/server/enterprise/services/agentCatalog` keep working after this extraction.
   */
  createEffectiveResolver?: (db: LobeChatDatabase) => EffectiveResolverSurface;
  createMaterializationService?: (db: LobeChatDatabase, userId: string) => MaterializationSurface;
  db: LobeChatDatabase;
  messageModel: Pick<MessageModel, 'findById' | 'findMessagePlugin'>;
  userId: string;
  validateDependencies?: typeof validateExactPlatformAgentDependencies;
}

export class PlatformAgentExecutionResolver {
  private readonly agentModel: PlatformAgentExecutionResolverDeps['agentModel'];
  private readonly agentOperationModel: PlatformAgentExecutionResolverDeps['agentOperationModel'];
  private readonly createEffectiveResolver: (db: LobeChatDatabase) => EffectiveResolverSurface;
  private readonly createMaterializationService: (
    db: LobeChatDatabase,
    userId: string,
  ) => MaterializationSurface;
  private readonly db: LobeChatDatabase;
  private readonly messageModel: PlatformAgentExecutionResolverDeps['messageModel'];
  private readonly userId: string;
  private readonly validateDependencies: typeof validateExactPlatformAgentDependencies;

  constructor(deps: PlatformAgentExecutionResolverDeps) {
    this.agentModel = deps.agentModel;
    this.agentOperationModel = deps.agentOperationModel;
    this.createEffectiveResolver =
      deps.createEffectiveResolver ?? ((db) => new PlatformAgentEffectiveResolver(db));
    this.createMaterializationService =
      deps.createMaterializationService ??
      ((db, userId) => new PlatformAgentMaterializationService(db, userId));
    this.db = deps.db;
    this.messageModel = deps.messageModel;
    this.userId = deps.userId;
    this.validateDependencies = deps.validateDependencies ?? validateExactPlatformAgentDependencies;
  }

  /**
   * Resolve the platform Agent an operation should run from the request identity.
   * Returns null for an ordinary agent / slug.
   */
  resolveIdentity = async (
    identifier: string,
    agentId: string | undefined,
    pausedResume?: {
      anchorMessageId: string | null;
      kind: ResumeInteractionKind;
      threadId: string | null;
      toolCallId: string;
      topicId: string | null;
    },
  ): Promise<PlatformAgentIdentityResolution | null> => {
    const encoded = decodePlatformAgentListId(identifier);
    if (encoded) return { platformAgentId: encoded };
    if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_AGENTS) return null;

    let inboxAgentId: string | undefined;
    if (identifier === INBOX_SESSION_ID) {
      inboxAgentId = (await this.agentModel.getBuiltinAgent(INBOX_SESSION_ID))?.id;
    } else if (agentId) {
      const candidate = await this.agentModel.getAgentConfigById(agentId);
      if (candidate?.slug === INBOX_SESSION_ID) inboxAgentId = candidate.id;
    }
    if (inboxAgentId) {
      if (pausedResume) {
        const pin = await this.resolveResumePlatformPin(
          pausedResume.anchorMessageId,
          pausedResume.kind,
          pausedResume.toolCallId,
          undefined,
          pausedResume.topicId,
          pausedResume.threadId,
        );
        if (!pin) {
          return throwAgentUnavailable();
        }
        return {
          capturedResumePin: pin,
          existingAgentId: inboxAgentId,
          platformAgentId: pin.platformAgentId,
        };
      }

      const handle = await new PlatformDefaultInboxService(this.db, this.userId).capture();
      if (!handle) return null;
      return { existingAgentId: inboxAgentId, handle, platformAgentId: handle.platformAgentId };
    }

    if (agentId) {
      const materializedPlatformAgentId = await new PlatformAgentCatalogRepository(
        this.db,
      ).getPlatformAgentIdByMaterializedAgentId(this.userId, agentId);
      if (materializedPlatformAgentId) return { platformAgentId: materializedPlatformAgentId };
    }
    return null;
  };

  /**
   * Resolve a platform Agent chat entry into an immutable execution plan (config + pin + policy).
   */
  resolveExecutionPlan = async (
    platformAgentId: string,
    identifier: string,
    resumeContext: {
      capturedHandle?: PlatformAgentOperationHandle;
      capturedResumePin?: PlatformOperationPin;
      existingAgentId?: string;
      pausedResumeKind?: ResumeInteractionKind;
      resumeAnchorMessageId: string | null;
      resumeToolCallId?: string;
      threadId: string | null;
      topicId: string | null;
    },
  ): Promise<PlatformAgentExecutionPlan> => {
    const materializationService = this.createMaterializationService(this.db, this.userId);
    const effectiveResolver = this.createEffectiveResolver(this.db);

    if (resumeContext.pausedResumeKind) {
      const pin =
        resumeContext.capturedResumePin ??
        (await this.resolveResumePlatformPin(
          resumeContext.resumeAnchorMessageId,
          resumeContext.pausedResumeKind,
          resumeContext.resumeToolCallId ?? '',
          platformAgentId,
          resumeContext.topicId,
          resumeContext.threadId,
        ));
      if (!pin || pin.platformAgentId !== platformAgentId) {
        return throwAgentUnavailable();
      }
      let entitled: boolean;
      try {
        entitled = await effectiveResolver.isEntitled(this.userId, platformAgentId);
      } catch (error) {
        return this.mapPlatformConfigError(error, platformAgentId, identifier);
      }
      if (!entitled) {
        return throwAgentUnavailable();
      }
      try {
        const materialized = resumeContext.existingAgentId
          ? await materializationService.resolveFromPinForExistingAgent(
              pin,
              resumeContext.existingAgentId,
            )
          : await materializationService.materializeFromPin(pin);
        await this.assertPlatformOperationDependencies(materialized.dependencySnapshot);
        if (resumeContext.existingAgentId) {
          materialized.config.slug = INBOX_SESSION_ID;
        }
        return this.toExecutionPlan({
          config: materialized.config,
          connectorRefs: materialized.dependencySnapshot.connectors,
          modelPin: materialized.dependencySnapshot.model,
          pin,
          skillRefs: materialized.dependencySnapshot.skills,
        });
      } catch (error) {
        return this.mapPlatformConfigError(error, platformAgentId, identifier);
      }
    }

    const handle =
      resumeContext.capturedHandle ??
      (await effectiveResolver.beginOperation(this.userId, platformAgentId));
    if (!handle) {
      return throwAgentUnavailable();
    }
    if (handle.platformAgentId !== platformAgentId) {
      return throwAgentUnavailable();
    }
    try {
      const snapshot = handle.getSnapshot();
      const materialized = resumeContext.existingAgentId
        ? await materializationService.resolveForExistingAgent(
            snapshot,
            resumeContext.existingAgentId,
          )
        : await materializationService.materializeForOperation(snapshot);
      await this.assertPlatformOperationDependencies(materialized.dependencySnapshot);
      if (resumeContext.existingAgentId) {
        materialized.config.slug = INBOX_SESSION_ID;
        if (materialized.config.platform && handle.distribution) {
          materialized.config.platform.distribution = handle.distribution;
        }
      }
      return this.toExecutionPlan({
        config: materialized.config,
        connectorRefs: materialized.dependencySnapshot.connectors,
        modelPin: materialized.dependencySnapshot.model,
        pin: {
          checksum: snapshot.checksum,
          platformAgentId: snapshot.platformAgentId,
          versionId: snapshot.versionId,
        },
        skillRefs: materialized.dependencySnapshot.skills,
      });
    } catch (error) {
      return this.mapPlatformConfigError(error, platformAgentId, identifier);
    }
  };

  private toExecutionPlan = (params: {
    config: AgentConfigWithId;
    connectorRefs: PlatformAgentConnectorDependencyRef[];
    modelPin: PlatformOperationModelPin;
    pin: PlatformOperationPin;
    skillRefs: PlatformAgentSkillDependencyRef[];
  }): PlatformAgentExecutionPlan => ({
    config: params.config,
    connectorRefs: params.connectorRefs,
    modelPin: params.modelPin,
    pin: params.pin,
    policy: {
      allowBuiltinRuntimeMerge: false,
      allowDeviceTools: false,
      allowGlobalMemory: false,
      allowInstructions: false,
      allowLocalSystem: false,
      allowModelOverride: false,
      allowPluginInjection: false,
      allowRemoteDevice: false,
      exactBuiltinToolIds: PLATFORM_AUDITED_BUILTIN_TOOL_IDS,
      managedPluginIds: [
        ...PLATFORM_AUDITED_BUILTIN_TOOL_IDS,
        ...params.connectorRefs.map(({ connectorKey }) => connectorKey),
      ],
    },
    skillRefs: params.skillRefs,
  });

  private mapPlatformConfigError = (
    error: unknown,
    platformAgentId: string | undefined,
    _identifier: string,
  ): never => {
    if (error instanceof PlatformAgentNotFoundError) {
      return throwAgentUnavailable();
    }
    if (error instanceof PlatformAgentDependencyValidationError) {
      log('platform dependency validation failed for %s', platformAgentId);
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_AGENT_DEPENDENCY_UNAVAILABLE,
        httpCode: 'PRECONDITION_FAILED',
      });
    }
    if (error instanceof PlatformAgentMaterializationError) {
      log('platform materialization failed for %s: %O', platformAgentId, error);
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_AGENT_START_FAILED,
        httpCode: 'INTERNAL_SERVER_ERROR',
      });
    }
    if (error instanceof TRPCError) throw error;
    log('unexpected platform config error for %s: %O', platformAgentId, error);
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_AGENT_START_FAILED,
      httpCode: 'INTERNAL_SERVER_ERROR',
    });
  };

  private assertPlatformOperationDependencies = async (
    dependencySnapshot: Parameters<typeof validateExactPlatformAgentDependencies>[1],
  ): Promise<void> => {
    await this.validateDependencies(this.db, dependencySnapshot);
  };

  private resolveResumePlatformPin = async (
    anchorMessageId: string | null,
    anchorKind: ResumeInteractionKind,
    toolCallId: string,
    platformAgentId: string | undefined,
    topicId: string | null,
    threadId: string | null,
  ): Promise<PlatformOperationPin | null> => {
    if (!anchorMessageId) return null;
    const anchor = await this.messageModel.findById(anchorMessageId);
    if (!anchor) return null;
    const plugin = await this.messageModel.findMessagePlugin(anchor.id);
    if (
      !plugin ||
      plugin.toolCallId !== toolCallId ||
      plugin.intervention?.kind !== anchorKind ||
      typeof plugin.apiName !== 'string' ||
      typeof plugin.arguments !== 'string' ||
      typeof plugin.identifier !== 'string'
    ) {
      return null;
    }
    const fingerprint = await fingerprintResumeToolCall({
      apiName: plugin.apiName,
      arguments: plugin.arguments,
      identifier: plugin.identifier,
      toolCallId,
      type: plugin.type,
    });
    return this.agentOperationModel.findResumablePlatformOperationPin({
      anchorKind,
      anchorMessageId: anchor.id,
      fingerprint,
      platformAgentId,
      threadId,
      toolCallId,
      topicId,
    });
  };
}
