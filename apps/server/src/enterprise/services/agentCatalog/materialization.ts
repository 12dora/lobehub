import { DEFAULT_AGENT_CONFIG } from '@lobechat/const';
import type {
  PlatformAgentConnectorDependencyRef,
  PlatformAgentModelDependencyRef,
  PlatformAgentSkillDependencyRef,
  PlatformAgentVersionConfig,
} from '@lobechat/types';
import type { LLMParams } from 'model-bank';

import { AgentModel } from '@/database/models/agent';
import {
  type ExactPlatformAgentVersion,
  PlatformAgentCatalogRepository,
  PlatformAgentMaterializationRaceError,
} from '@/database/repositories/platformAgentCatalog';
import type { AgentItem } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import type { AgentConfigWithId } from '@/server/services/agent';

import type { PlatformAgentOperationSnapshot } from './effectiveResolver';
import { PlatformAgentMaterializationError, PlatformAgentNotFoundError } from './errors';

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

/** A model reference is usable only with a concrete provider + model key and a valid checksum. */
const isValidModelRef = (ref: PlatformAgentModelDependencyRef | undefined): boolean =>
  !!ref &&
  ref.providerKey.length > 0 &&
  ref.modelKey.length > 0 &&
  CHECKSUM_PATTERN.test(ref.providerChecksum);

const isValidSkillRef = (ref: PlatformAgentSkillDependencyRef): boolean =>
  ref.skillKey.length > 0 && ref.version.length > 0 && CHECKSUM_PATTERN.test(ref.checksum);

const isValidConnectorRef = (ref: PlatformAgentConnectorDependencyRef): boolean =>
  ref.connectorKey.length > 0 && CHECKSUM_PATTERN.test(ref.publishedChecksum);

/**
 * Map the immutable, secret-free platform model parameters onto the runtime `LLMParams` shape.
 * Only defined values are forwarded so unset managed parameters fall back to the runtime defaults.
 */
const mapModelParameters = (config: PlatformAgentVersionConfig): LLMParams => {
  const mp = config.modelParameters;
  const params: LLMParams = {};
  if (mp.frequencyPenalty !== undefined) params.frequency_penalty = mp.frequencyPenalty;
  if (mp.maxTokens !== undefined) params.max_tokens = mp.maxTokens;
  if (mp.presencePenalty !== undefined) params.presence_penalty = mp.presencePenalty;
  if (mp.temperature !== undefined) params.temperature = mp.temperature;
  if (mp.topP !== undefined) params.top_p = mp.topP;
  return params;
};

/**
 * Delayed materialization of a platform Agent into a local user-owned Agent row (M10 PR-049 · B).
 *
 * The local row is ONLY a persistence/FK-compatible attribution identity: messages and operations
 * key on a real `agents.id`. The runtime configuration authority is the pinned operation snapshot,
 * NOT this row — {@link materializeForOperation} always derives the returned runtime config from the
 * exact pinned version, so a user tampering with the local row can never change the managed runtime.
 *
 * Never materializes on list reads; only a caller that genuinely needs a local Agent (the chat
 * runtime) reaches this. Owner-scoped throughout: the row is created and read under the trusted
 * `userId`. Creation + mapping are one transaction (see `repository.materializeLocalAgent`), so N
 * concurrent operations leave exactly one mapping and one Agent with no orphan.
 */
export class PlatformAgentMaterializationService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
    private readonly repository = new PlatformAgentCatalogRepository(db),
  ) {}

  /**
   * Ensure a local user-owned Agent exists for the pinned operation snapshot and return its id plus
   * the snapshot-derived runtime config. Fail-closed: a missing exact version, a checksum mismatch,
   * or malformed model/skill/connector refs raise a stable, redacted error rather than running with
   * a partially-pinned config.
   */
  materializeForOperation = async (
    snapshot: PlatformAgentOperationSnapshot,
  ): Promise<{ agentId: string; config: AgentConfigWithId }> => {
    const version = this.resolveExactVersion(
      await this.repository.getExactVersion(snapshot.platformAgentId, snapshot.versionId),
      snapshot,
    );
    const model = version.dependencySnapshot.model;

    const agentId = await this.attachLocalAgent(snapshot, model);
    return { agentId, config: this.buildRuntimeConfig(agentId, snapshot.config, model) };
  };

  /** Fail-closed validation that the fetched version exactly matches the pinned snapshot. */
  private resolveExactVersion = (
    version: ExactPlatformAgentVersion | undefined,
    snapshot: PlatformAgentOperationSnapshot,
  ): ExactPlatformAgentVersion => {
    if (!version || version.checksum !== snapshot.checksum) {
      throw new PlatformAgentMaterializationError();
    }
    const deps = version.dependencySnapshot;
    if (
      !deps ||
      !isValidModelRef(deps.model) ||
      !deps.skills.every(isValidSkillRef) ||
      !deps.connectors.every(isValidConnectorRef)
    ) {
      throw new PlatformAgentMaterializationError();
    }
    return version;
  };

  private attachLocalAgent = async (
    snapshot: PlatformAgentOperationSnapshot,
    model: PlatformAgentModelDependencyRef,
  ): Promise<string> => {
    const localRow = this.buildLocalAgentRow(snapshot.config, model);
    try {
      const result = await this.repository.materializeLocalAgent({
        createLocalAgent: (tx) => new AgentModel(tx, this.userId).create(localRow),
        platformAgentId: snapshot.platformAgentId,
        platformAgentVersionChecksum: snapshot.checksum,
        platformAgentVersionId: snapshot.versionId,
        userId: this.userId,
      });
      // Archived between authorization and materialize (lost archive race) → not entitled.
      if (!result.ok) throw new PlatformAgentNotFoundError();
      return result.agentId;
    } catch (error) {
      if (error instanceof PlatformAgentNotFoundError) throw error;
      if (error instanceof PlatformAgentMaterializationRaceError) {
        // The tx rolled back the just-created Agent; reuse the winning owner-scoped mapping.
        const existing = await this.repository.getMaterialization(
          this.userId,
          snapshot.platformAgentId,
        );
        if (!existing?.materializedAgentId) throw new PlatformAgentMaterializationError();
        return existing.materializedAgentId;
      }
      // Redact any raw DB / driver failure at the boundary.
      throw new PlatformAgentMaterializationError();
    }
  };

  /** Local attribution row — managed fields mapped from the pinned version, no secrets. */
  private buildLocalAgentRow = (
    config: PlatformAgentVersionConfig,
    model: PlatformAgentModelDependencyRef,
  ): Partial<AgentItem> => ({
    avatar: config.avatar,
    backgroundColor: config.backgroundColor,
    description: config.description,
    model: model.modelKey,
    openingMessage: config.openingMessage,
    openingQuestions: config.openingQuestions,
    params: mapModelParameters(config),
    // Tool wiring is resolved at runtime by the managed skill/connector projection (M08/M09),
    // not persisted onto this attribution row.
    plugins: [],
    provider: model.providerKey,
    systemRole: config.systemRole,
    tags: config.tags,
    title: config.displayName,
  });

  /**
   * Runtime config for the operation, derived ONLY from the pinned snapshot (+ exact model ref).
   * Never reads the local row back, so a newer published version that advanced the row cannot leak
   * into an already-started operation.
   */
  private buildRuntimeConfig = (
    agentId: string,
    config: PlatformAgentVersionConfig,
    model: PlatformAgentModelDependencyRef,
  ): AgentConfigWithId => ({
    ...DEFAULT_AGENT_CONFIG,
    avatar: config.avatar ?? undefined,
    backgroundColor: config.backgroundColor ?? undefined,
    id: agentId,
    model: model.modelKey,
    openingMessage: config.openingMessage ?? undefined,
    openingQuestions: config.openingQuestions,
    params: { ...DEFAULT_AGENT_CONFIG.params, ...mapModelParameters(config) },
    plugins: [],
    provider: model.providerKey,
    // Not a builtin slug — keeps the builtin runtime-config merge in execAgent inert.
    slug: null,
    systemRole: config.systemRole,
    title: config.displayName,
  });
}
