import type { PlatformSkillOperationSnapshot, SkillMeta } from '@lobechat/context-engine';
import { resourcesTreePrompt } from '@lobechat/prompts';
import type { AgentPluginEntry } from '@lobechat/types';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { PlatformManagedResourcePolicyModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import { getPluginMode } from '@/types/agent/pluginConfig';
import { resolvePlatformSkillSelection } from '@/types/platform/skills';

import type { PublishedSkill } from '../../contracts/skillCatalog';
import { getBuiltinSkillDefinitions } from './builtinAdapter';
import { SkillCatalogReadService } from './readService';
import { isPublishedSkillCatalogExecutionReady } from './runtimeReadiness';

const MAX_OPERATION_SKILLS = 10_000;

export interface PlatformSkillRuntimeSnapshot {
  catalog: PlatformSkillOperationSnapshot;
  skills: SkillMeta[];
}

export interface ResolvePlatformSkillRuntimeSnapshotOptions {
  catalogService?: Pick<
    SkillCatalogReadService,
    'getPublishedCatalog' | 'resolvePinnedForExecution'
  >;
  policyModel?: Pick<PlatformManagedResourcePolicyModel, 'getSnapshot'>;
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

/**
 * Resolve the operation-level managed Skill boundary.
 *
 * Feature-off returns before constructing either DB-backed service. A managed
 * policy only replaces the legacy/user-owned pool in the final `enforced`
 * mode; observe/ui-only retain upstream behavior.
 */
export const resolvePlatformSkillRuntimeSnapshot = async (params: {
  agentPlugins?: AgentPluginEntry[];
  db: LobeChatDatabase;
  flags: EnterpriseFeatureFlags;
  options?: ResolvePlatformSkillRuntimeSnapshotOptions;
}): Promise<PlatformSkillRuntimeSnapshot | undefined> => {
  if (!params.flags.ENABLE_PLATFORM_MANAGED_SKILLS) return undefined;

  const policyModel =
    params.options?.policyModel ?? new PlatformManagedResourcePolicyModel(params.db);
  const policySnapshot = await policyModel.getSnapshot();
  const policy = policySnapshot.published.skills;
  if (
    policySnapshot.status !== 'published' ||
    !policy.managed ||
    policy.enforcementMode !== 'enforced'
  ) {
    return undefined;
  }

  const catalogService =
    params.options?.catalogService ??
    new SkillCatalogReadService(params.db, { builtinSkills: getBuiltinSkillDefinitions() });
  const published = await catalogService.getPublishedCatalog();
  if (published.skills.length > MAX_OPERATION_SKILLS) {
    throw new Error('Published Skill operation snapshot limit was exceeded');
  }
  if (
    !(await isPublishedSkillCatalogExecutionReady({ catalog: published, service: catalogService }))
  ) {
    throw new Error('Published Skill catalog is not execution-ready');
  }
  const selected = published.skills.flatMap((skill) => {
    const selection = resolvePlatformSkillSelection(
      skill.distribution,
      getPluginMode(params.agentPlugins, skill.skillKey),
    );
    return selection.available ? [{ selection, skill }] : [];
  });
  const skills = await Promise.all(
    selected.map(async ({ selection, skill }) => {
      const meta = toSkillMeta(skill);
      if (!selection.activated) return meta;
      const resolved = await catalogService.resolvePinnedForExecution({
        checksum: skill.checksum,
        skillKey: skill.skillKey,
        version: skill.version,
      });
      if (!resolved) throw new Error(`Published Skill ${skill.skillKey} could not be resolved`);
      return { ...meta, activated: true, content: buildResolvedContent(resolved) };
    }),
  );

  return {
    catalog: freezeOperationSnapshot({
      mandatorySkillIds: selected.flatMap(({ skill }) =>
        skill.distribution === 'mandatory' ? [skill.skillKey] : [],
      ),
      refs: selected.map(({ skill: { checksum, skillKey, version } }) => ({
        checksum,
        skillKey,
        version,
      })),
      revision: published.revision,
    }),
    skills,
  };
};
