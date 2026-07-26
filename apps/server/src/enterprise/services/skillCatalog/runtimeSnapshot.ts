import type { PlatformSkillOperationSnapshot, SkillMeta } from '@lobechat/context-engine';
import { resourcesTreePrompt } from '@lobechat/prompts';
import type { AgentPluginEntry, PlatformAgentSkillDependencyRef } from '@lobechat/types';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import type { LobeChatDatabase } from '@/database/type';
import { signPlatformSkillOperationProof } from '@/libs/trpc/utils/internalJwt';

import type { PublishedSkill } from '../../contracts/skillCatalog';
import { getBuiltinSkillDefinitions } from './builtinAdapter';
import { selectPlatformOperationSkills } from './operationSelection';
import { SkillCatalogReadService } from './readService';
import { isPublishedSkillCatalogExecutionReady } from './runtimeReadiness';

const MAX_OPERATION_SKILLS = 10_000;
const MAX_OPERATION_SKILL_PAYLOAD_BYTES = 8 * 1024 * 1024;

export interface PlatformSkillRuntimeSnapshot {
  catalog: PlatformSkillOperationSnapshot;
  skills: SkillMeta[];
}

export interface ResolvePlatformSkillRuntimeSnapshotOptions {
  catalogService?: Pick<
    SkillCatalogReadService,
    'getPublishedCatalog' | 'resolvePinnedForExecution'
  > &
    Partial<Pick<SkillCatalogReadService, 'isPublishedCatalogExecutionReady'>>;
  signProof?: typeof signPlatformSkillOperationProof;
}

const toSkillMeta = (skill: PublishedSkill): SkillMeta => ({
  description: skill.description ?? skill.displayName,
  identifier: skill.skillKey,
  name: skill.skillKey,
});

const freezeOperationSnapshot = (
  snapshot: PlatformSkillOperationSnapshot,
): PlatformSkillOperationSnapshot => {
  const clone = structuredClone(snapshot);
  for (const ref of clone.refs) Object.freeze(ref);
  Object.freeze(clone.refs);
  Object.freeze(clone.mandatorySkillIds);
  return Object.freeze(clone) as PlatformSkillOperationSnapshot;
};

const buildResolvedContent = (
  resolved: NonNullable<Awaited<ReturnType<SkillCatalogReadService['resolvePinnedForExecution']>>>,
) => {
  if (resolved.resources.length === 0) return resolved.content;
  const resources = Object.fromEntries(
    resolved.resources.map((resource) => [
      resource.path,
      { content: resource.content, fileHash: resource.checksum, size: resource.sizeBytes },
    ]),
  );
  return `${resolved.content}\n\n${resourcesTreePrompt(resolved.displayName, resources)}`;
};

const createOperationPayloadAccumulator = () => {
  let payloadBytes = 0;

  return (skill: SkillMeta): SkillMeta => {
    payloadBytes += Buffer.byteLength(JSON.stringify(skill), 'utf8');
    if (payloadBytes > MAX_OPERATION_SKILL_PAYLOAD_BYTES) {
      throw new Error('Platform Skill operation payload limit was exceeded');
    }
    return skill;
  };
};

/**
 * Resolve the operation-level managed Skill boundary.
 *
 * Feature-off returns before constructing either DB-backed service. A managed
 * policy only replaces the legacy/user-owned pool in the final `enforced`
 * mode; observe/ui-only retain upstream behavior.
 */
export const resolvePlatformSkillRuntimeSnapshot = async (params: {
  agentPlugins?: AgentPluginEntry[];
  effectiveMode: 'enforced' | 'observe' | 'ui-only' | 'unmanaged';
  db: LobeChatDatabase;
  flags: EnterpriseFeatureFlags;
  identity: { agentId: string; operationId: string; userId: string };
  options?: ResolvePlatformSkillRuntimeSnapshotOptions;
}): Promise<PlatformSkillRuntimeSnapshot | undefined> => {
  if (!params.flags.ENABLE_PLATFORM_MANAGED_SKILLS || params.effectiveMode !== 'enforced')
    return undefined;

  const catalogService =
    params.options?.catalogService ??
    new SkillCatalogReadService(params.db, {
      builtinSkills: getBuiltinSkillDefinitions(),
      runtimeReporting: { database: params.db },
    });
  const published = await catalogService.getPublishedCatalog();
  if (published.skills.length > MAX_OPERATION_SKILLS) {
    throw new Error('Published Skill operation snapshot limit was exceeded');
  }
  if (
    !(await isPublishedSkillCatalogExecutionReady({ catalog: published, service: catalogService }))
  ) {
    throw new Error('Published Skill catalog is not execution-ready');
  }
  const selected = selectPlatformOperationSkills(published.skills, params.agentPlugins);
  const accumulatePayload = createOperationPayloadAccumulator();
  const skills: SkillMeta[] = [];
  for (const { selection, skill } of selected) {
    const meta = toSkillMeta(skill);
    if (!selection.activated) {
      skills.push(accumulatePayload(meta));
      continue;
    }
    const resolved = await catalogService.resolvePinnedForExecution({
      checksum: skill.checksum,
      skillKey: skill.skillKey,
      version: skill.version,
    });
    // RR2-5: fail closed WITHOUT naming the Skill — the skillKey is an internal catalog
    // identifier and must never surface to the caller.
    if (!resolved) throw new Error('A published platform Skill could not be resolved');
    skills.push(
      accumulatePayload({
        ...meta,
        activated: true,
        content: buildResolvedContent(resolved),
      }),
    );
  }

  const refs = selected.map(({ skill: { checksum, skillKey, version } }) => ({
    checksum,
    skillKey,
    version,
  }));
  const proof = await (params.options?.signProof ?? signPlatformSkillOperationProof)({
    ...params.identity,
    refs,
    revision: published.revision,
  });

  return {
    catalog: freezeOperationSnapshot({
      agentId: params.identity.agentId,
      mandatorySkillIds: selected.flatMap(({ skill }) =>
        skill.distribution === 'mandatory' ? [skill.skillKey] : [],
      ),
      operationId: params.identity.operationId,
      proof,
      refs,
      revision: published.revision,
    }),
    skills,
  };
};

/**
 * Revision marker bound into the proof of a platform-Agent pinned-skill snapshot. The pinned refs
 * (skillKey/version/checksum) — not a catalog head — are the authority; the value is only a stable,
 * consistent binding checked equal by the activation verifier, so a fixed marker is correct.
 */
const PINNED_SKILL_OPERATION_REVISION = 'platform-agent-pinned';

/**
 * Resolve the operation-level Skill boundary for a managed platform Agent from its immutable,
 * per-operation pinned Skill refs (M10 PR-049 · SKILL-EXACT) — NOT the moving catalog head.
 *
 * The `dependencySnapshot.skills` `{skillKey, version, checksum}` captured on the Agent version are
 * the sole authority: each is exact-resolved (`resolvePinnedForExecution`, which fail-closes on a
 * missing / superseded / checksum-mismatched version), so the model sees and activates the exact
 * historical Skill content the operation started on. Publishing v2 / advancing the catalog head
 * cannot change an in-flight operation's Skills. The returned snapshot fully REPLACES the ordinary
 * builtin/db/project pool (the platform Agent's Skills are exactly its pinned set — an empty set
 * therefore yields an empty pool). Fail-closed when the managed-Skills feature is off but the Agent
 * pinned Skills (they could never be activated). No M08 read when there are no pinned Skills.
 */
export const resolvePinnedPlatformSkillRuntimeSnapshot = async (params: {
  db: LobeChatDatabase;
  flags: EnterpriseFeatureFlags;
  identity: { agentId: string; operationId: string; userId: string };
  options?: ResolvePlatformSkillRuntimeSnapshotOptions;
  pinnedSkills: PlatformAgentSkillDependencyRef[];
}): Promise<PlatformSkillRuntimeSnapshot> => {
  const signProof = params.options?.signProof ?? signPlatformSkillOperationProof;
  const buildSnapshot = (
    refs: PlatformSkillOperationSnapshot['refs'],
    proof: string,
  ): PlatformSkillOperationSnapshot =>
    freezeOperationSnapshot({
      agentId: params.identity.agentId,
      // Every pinned Skill is part of the Agent's declared, non-user-mutable set.
      mandatorySkillIds: refs.map((ref) => ref.skillKey),
      operationId: params.identity.operationId,
      proof,
      refs,
      revision: PINNED_SKILL_OPERATION_REVISION,
    });

  if (params.pinnedSkills.length === 0) {
    const proof = await signProof({
      ...params.identity,
      refs: [],
      revision: PINNED_SKILL_OPERATION_REVISION,
    });
    return { catalog: buildSnapshot([], proof), skills: [] };
  }

  if (!params.flags.ENABLE_PLATFORM_MANAGED_SKILLS) {
    // The Agent pinned Skills but the managed-Skills feature is off — they could never be activated.
    throw new Error('Platform managed Skills are required to run this Agent');
  }

  const catalogService =
    params.options?.catalogService ??
    new SkillCatalogReadService(params.db, { builtinSkills: getBuiltinSkillDefinitions() });
  const refs = params.pinnedSkills.map(({ checksum, skillKey, version }) => ({
    checksum,
    skillKey,
    version,
  }));
  const accumulatePayload = createOperationPayloadAccumulator();
  const skills: SkillMeta[] = [];
  for (const ref of refs) {
    const resolved = await catalogService.resolvePinnedForExecution(ref);
    // RR2-5: fail closed WITHOUT naming the Skill — `skillKey@version` is an internal pinned
    // identifier and must never surface to the caller.
    if (!resolved) {
      throw new Error('A pinned platform Skill could not be resolved');
    }
    skills.push(
      accumulatePayload({
        activated: true,
        content: buildResolvedContent(resolved),
        description: resolved.description ?? resolved.displayName,
        identifier: resolved.skillKey,
        name: resolved.skillKey,
      }),
    );
  }
  const proof = await signProof({
    ...params.identity,
    refs,
    revision: PINNED_SKILL_OPERATION_REVISION,
  });
  return { catalog: buildSnapshot(refs, proof), skills };
};
