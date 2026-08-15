import {
  type UserPersonaDocument,
  type UserPersonaDocumentHistoriesItem,
} from '@lobechat/database/schemas';
import { userMemories } from '@lobechat/database/schemas';
import { type UserPersonaExtractionResult } from '@lobechat/memory-user-memory';
import {
  RetrievalUserMemoryContextProvider,
  RetrievalUserMemoryIdentitiesProvider,
  UserPersonaExtractor,
} from '@lobechat/memory-user-memory';
import { mergeModelRuntimeHooks } from '@lobechat/model-runtime';
import type { UserServiceModelConfig } from '@lobechat/types';
import { desc, eq } from 'drizzle-orm';

import { getBusinessModelRuntimeHooks } from '@/business/server/model-runtime';
import { UserMemoryModel } from '@/database/models/userMemory';
import { UserPersonaModel } from '@/database/models/userMemory/persona';
import { AiInfraRepos } from '@/database/repositories/aiInfra';
import { type LobeChatDatabase } from '@/database/type';
import { getEffectiveSystemAgentConfig } from '@/server/enterprise/services/settings/runtimeSettingsAdapter';
import { type MemoryAgentConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import { parseMemoryExtractionConfig } from '@/server/globalConfig/parseMemoryExtractionConfig';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import {
  buildPayloadFromKeyVaults,
  initModelRuntimeWithUserPayload,
} from '@/server/modules/ModelRuntime';
import {
  assertPlatformPublishedModel,
  createPlatformAiModelAllowlistHooks,
  listPlatformPublishedModels,
  resolvePlatformAiExecutionConfig,
  resolvePlatformAiRuntimeState,
} from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';
import {
  type ProviderKeyVaultMap,
  type RuntimeResolveOptions,
} from '@/server/services/memory/userMemory/extract';
import { resolveRuntimeAgentConfig } from '@/server/services/memory/userMemory/extract';
import { LayersEnum } from '@/types/userMemory';
import { trimBasedOnBatchProbe } from '@/utils/chunkers';

interface UserPersonaAgentPayload {
  existingPersona?: string | null;
  language?: string;
  memoryIds?: string[];
  metadata?: Record<string, unknown>;
  personaNotes?: string;
  recentEvents?: string;
  retrievedMemories?: string;
  sourceIds?: string[];
  userId: string;
  username?: string;
  userProfile?: string;
}

interface UserPersonaAgentResult {
  agentResult: UserPersonaExtractionResult;
  diff?: UserPersonaDocumentHistoriesItem;
  document: UserPersonaDocument;
}

const resolvePositiveInteger = (value?: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;

  return Math.floor(value);
};

const normalizeProvider = (provider: string) => provider.toLowerCase();

export class UserPersonaService {
  private readonly preferredLanguage?: string;
  private readonly db: LobeChatDatabase;
  private readonly agentConfig: MemoryAgentConfig;

  constructor(db: LobeChatDatabase) {
    const { agentPersonaWriter } = parseMemoryExtractionConfig();

    this.db = db;
    this.preferredLanguage = agentPersonaWriter.language;
    this.agentConfig = agentPersonaWriter;
  }

  private async resolveAgentConfig(userId: string): Promise<MemoryAgentConfig> {
    const systemAgent = (await getEffectiveSystemAgentConfig({
      db: this.db,
      userId,
    })) as Partial<UserServiceModelConfig> | undefined;
    const userMemoryPersonaWriter = systemAgent?.userMemoryPersonaWriter;
    const provider = userMemoryPersonaWriter?.provider || this.agentConfig.provider;
    const shouldInheritCredentials =
      !userMemoryPersonaWriter?.provider ||
      normalizeProvider(userMemoryPersonaWriter.provider) ===
        normalizeProvider(this.agentConfig.provider || 'openai');

    return {
      apiKey: shouldInheritCredentials ? this.agentConfig.apiKey : undefined,
      baseURL: shouldInheritCredentials ? this.agentConfig.baseURL : undefined,
      contextLimit:
        resolvePositiveInteger(userMemoryPersonaWriter?.contextLimit) ??
        this.agentConfig.contextLimit,
      language: this.agentConfig.language,
      model: userMemoryPersonaWriter?.model || this.agentConfig.model,
      provider,
    };
  }

  async composeWriting(payload: UserPersonaAgentPayload): Promise<UserPersonaAgentResult> {
    const agentConfig = await this.resolveAgentConfig(payload.userId);
    // workspace-audit: intentionally personal-scoped (no workspaceId). Persona is a
    // purely user-level feature with no workspace concept; the payload carries no
    // workspaceId, so provider config is resolved against the user's personal scope.
    const aiInfraRepos = new AiInfraRepos(this.db, payload.userId, {});
    // Platform takeover is authorized by the published 平台托管 policy, not by the feature flag:
    // `resolvePlatformAiRuntimeState` returns the caller's own state verbatim until 平台托管 is
    // published, and merges the platform catalog over it afterwards — so the user's BYOK
    // providers stay selectable in both regimes.
    const upstreamState = await aiInfraRepos.getAiProviderRuntimeState(
      KeyVaultsGateKeeper.getUserKeyVaults,
    );
    const runtimeState = await resolvePlatformAiRuntimeState({ db: this.db, upstreamState });
    const providerId = await AiInfraRepos.tryMatchingProviderFrom(runtimeState, {
      fallbackProvider: agentConfig.provider,
      label: 'persona writer',
      modelId: agentConfig.model,
    });
    // The platform governs only the providers it publishes as enabled. `null` means "not
    // actively managed" (never published, disabled, archived, or no 平台托管 at all), in which
    // case this provider is the user's own and runs on their credentials.
    const managed = (await listPlatformPublishedModels(this.db, providerId)) !== null;

    const hooks = getBusinessModelRuntimeHooks(payload.userId, 'lobehub');
    const runtime = managed
      ? await (async () => {
          assertPlatformPublishedModel(runtimeState, providerId, agentConfig.model, 'chat');
          const execution = await resolvePlatformAiExecutionConfig(this.db, providerId);
          const secretPayload = buildPayloadFromKeyVaults(
            execution.keyVaults,
            execution.runtimeProvider,
          );
          return initModelRuntimeWithUserPayload(
            providerId,
            secretPayload,
            { userId: payload.userId },
            mergeModelRuntimeHooks(
              createPlatformAiModelAllowlistHooks(execution.allowedModels),
              hooks,
            ),
          );
        })()
      : await resolveRuntimeAgentConfig(
          agentConfig,
          Object.entries(runtimeState.runtimeConfig || {}).reduce((acc, [provider, config]) => {
            acc[provider.toLowerCase()] = config?.keyVaults;
            return acc;
          }, {} as ProviderKeyVaultMap),
          {
            fallback: {
              apiKey: agentConfig.apiKey,
              baseURL: agentConfig.baseURL,
            },
            preferred: { providerIds: [providerId] },
            userId: payload.userId,
          } satisfies RuntimeResolveOptions,
          hooks,
        );

    const personaModel = new UserPersonaModel(this.db, payload.userId);
    const lastDocument = await personaModel.getLatestPersonaDocument();
    const existingPersonaBaseline = payload.existingPersona ?? lastDocument?.persona;

    const extractor = new UserPersonaExtractor({
      agent: 'user-persona',
      model: agentConfig.model,
      modelRuntime: runtime,
    });

    const agentResult = await extractor.toolCall({
      existingPersona: existingPersonaBaseline || undefined,
      language: payload.language || this.preferredLanguage,
      personaNotes: payload.personaNotes,
      recentEvents: payload.recentEvents,
      retrievedMemories: payload.retrievedMemories,
      userProfile: payload.userProfile,
      username: payload.username,
    });

    const persisted = await personaModel.upsertPersona({
      capturedAt: new Date(),
      diffPersona: agentResult.diff ?? undefined,
      editedBy: 'agent',
      memoryIds: payload.memoryIds ?? agentResult.memoryIds ?? undefined,
      metadata: payload.metadata ?? undefined,
      persona: agentResult.persona,
      reasoning: agentResult.reasoning ?? undefined,
      snapshot: agentResult.persona,
      sourceIds: payload.sourceIds ?? agentResult.sourceIds ?? undefined,
      tagline: agentResult.tagline ?? undefined,
    });

    return { agentResult, ...persisted };
  }
}

export const buildUserPersonaJobInput = async (db: LobeChatDatabase, userId: string) => {
  const personaModel = new UserPersonaModel(db, userId);
  const latestPersona = await personaModel.getLatestPersonaDocument();
  const { agentPersonaWriter } = parseMemoryExtractionConfig();
  const systemAgent = (await getEffectiveSystemAgentConfig({
    db,
    userId,
  })) as Partial<UserServiceModelConfig> | undefined;
  const userMemoryPersonaWriter = systemAgent?.userMemoryPersonaWriter;
  const personaContextLimit =
    resolvePositiveInteger(userMemoryPersonaWriter?.contextLimit) ??
    agentPersonaWriter.contextLimit;

  const userMemoryModel = new UserMemoryModel(db, userId);

  const [identities, activities, contexts, preferences, memories] = await Promise.all([
    userMemoryModel.getAllIdentitiesWithMemory(),
    // TODO(@nekomeowww): @arvinxx kindly take some time to review this policy
    userMemoryModel.listMemories({ layer: LayersEnum.Activity, pageSize: 3 }),
    userMemoryModel.listMemories({ layer: LayersEnum.Context, pageSize: 3 }),
    userMemoryModel.listMemories({ layer: LayersEnum.Preference, pageSize: 10 }),
    db.query.userMemories.findMany({
      limit: 20,
      orderBy: [desc(userMemories.capturedAt)],
      where: eq(userMemories.userId, userId),
    }),
  ]);

  const contextProvider = new RetrievalUserMemoryContextProvider({
    retrievedMemories: {
      activities: activities.map((a) => a.activity),
      contexts: contexts.map((c) => c.context),
      experiences: [],
      preferences: preferences.map((p) => p.preference),
    },
  });

  const identityProvider = new RetrievalUserMemoryIdentitiesProvider({
    retrievedIdentities: identities.map((i) => ({
      ...i,
      layer: LayersEnum.Identity,
    })),
  });

  const [recentMemoriesContext, allIdentitiesContext] = await Promise.all([
    contextProvider.buildContext(userId, 'user-persona-memories'),
    identityProvider.buildContext(userId, 'user-persona-memories-identities'),
  ]);

  const rawContext = [recentMemoriesContext.context, allIdentitiesContext.context]
    .filter(Boolean)
    .join('\n\n');

  const trimmedContext = rawContext
    ? await trimBasedOnBatchProbe(rawContext, personaContextLimit)
    : '';
  const assembledContext = trimmedContext?.trim();

  return {
    existingPersona: latestPersona?.persona || undefined,
    memoryIds: memories.map((m) => m.id),
    retrievedMemories: assembledContext || undefined,
  };
};
