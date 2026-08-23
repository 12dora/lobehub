import type { PlatformPublishedSkillView } from '@/database/models/platform';

import type { PublishedSkill } from '../../contracts/skillCatalog';
import type { CurrentSkillCatalogSnapshot } from '../platformInstance/catalogAuthority';
import { buildSkillCatalogRevisionToken } from '../platformInstance/catalogTokens';
import { cacheReadiness, cloneCatalog, storePublishedProjection } from './readServiceCache';
import type { BuiltinSkillDefinition, ResolvedSkill } from './resolvedSkill';
import {
  exactRefKey,
  isCanonicalExactResolution,
  parseResolvedBuiltinSkill,
  parseResolvedPlatformSkill,
} from './resolvedSkill';

const MAX_PUBLISHED_SKILLS = 10_000;
const MAX_PUBLISHED_SKILL_PAYLOAD_BYTES = 8 * 1024 * 1024;

const compareCodepoint = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const projectPlatformItems = (
  platformItems: PlatformPublishedSkillView[],
  builtins: Map<string, BuiltinSkillDefinition>,
) => {
  const platformSkills: PublishedSkill[] = [];
  const platformResolvedByKey = new Map<string, ResolvedSkill>();
  let projectionContainsInvalidItems = false;
  for (const item of platformItems) {
    if (builtins.has(item.skillKey) && !item.allowBuiltinOverride) continue;
    // Per-item resilience: one corrupt published skill must not take down the entire
    // managed catalog projection (availability DoS from stale sizeBytes/etc.).
    let resolved: ResolvedSkill;
    try {
      resolved = parseResolvedPlatformSkill(item);
    } catch {
      projectionContainsInvalidItems = true;
      continue;
    }
    platformSkills.push({
      checksum: item.version.checksum,
      description: item.description,
      displayName: item.displayName,
      distribution: item.distribution,
      skillKey: item.skillKey,
      source: item.source,
      version: item.version.version,
    });
    platformResolvedByKey.set(item.skillKey, resolved);
  }
  return { platformResolvedByKey, platformSkills, projectionContainsInvalidItems };
};

const mergePublishedSkills = (
  builtins: Map<string, BuiltinSkillDefinition>,
  platformSkills: PublishedSkill[],
) => {
  const merged = new Map<string, PublishedSkill>(builtins);
  for (const skill of platformSkills) merged.set(skill.skillKey, skill);
  const skills = [...merged.values()]
    .map(({ checksum, description, displayName, distribution, skillKey, source, version }) => ({
      checksum,
      description,
      displayName,
      distribution,
      skillKey,
      source,
      version,
    }))
    .sort((left, right) => compareCodepoint(left.skillKey, right.skillKey));
  if (skills.length > MAX_PUBLISHED_SKILLS) {
    throw new Error('Published Skill item limit was exceeded after builtin merge');
  }
  return skills;
};

const indexExecutableSkills = (
  skills: PublishedSkill[],
  builtinSkills: BuiltinSkillDefinition[],
  platformResolvedByKey: Map<string, ResolvedSkill>,
  projectionContainsInvalidItems: boolean,
) => {
  const executionIndex = new Map<string, ResolvedSkill>();
  let executionReady = !projectionContainsInvalidItems;
  let payloadBytes = 0;
  for (const skill of skills) {
    const builtin = builtinSkills.find((item) => item.skillKey === skill.skillKey);
    const resolved =
      platformResolvedByKey.get(skill.skillKey) ??
      (builtin ? parseResolvedBuiltinSkill(builtin) : undefined);
    const ref = { checksum: skill.checksum, skillKey: skill.skillKey, version: skill.version };
    if (
      !resolved ||
      !isCanonicalExactResolution(ref, resolved) ||
      resolved.contentRef !== null ||
      resolved.resources.some(
        (resource) => resource.content === undefined || resource.contentRef !== undefined,
      )
    ) {
      executionReady = false;
      continue;
    }
    const resolvedBytes = Buffer.byteLength(JSON.stringify(resolved), 'utf8');
    payloadBytes += resolvedBytes;
    if (payloadBytes > MAX_PUBLISHED_SKILL_PAYLOAD_BYTES) {
      throw new Error('Published Skill aggregate payload limit was exceeded');
    }
    executionIndex.set(exactRefKey(ref), structuredClone(resolved));
  }
  return { executionIndex, executionReady, payloadBytes };
};

export const loadPublishedSkillProjection = async (params: {
  builtinSkills: BuiltinSkillDefinition[];
  loadCurrentSnapshot: () => Promise<CurrentSkillCatalogSnapshot>;
  projectionSource: string;
}): Promise<string> => {
  const snapshot = await params.loadCurrentSnapshot();
  if (snapshot.items.length > MAX_PUBLISHED_SKILLS) {
    throw new Error('Published Skill item limit was exceeded');
  }
  const builtins = new Map(params.builtinSkills.map((skill) => [skill.skillKey, skill] as const));
  for (const skillKey of snapshot.builtinOverrideTombstones) builtins.delete(skillKey);
  const { platformResolvedByKey, platformSkills, projectionContainsInvalidItems } =
    projectPlatformItems(snapshot.items, builtins);
  const skills = mergePublishedSkills(builtins, platformSkills);
  const revision = buildSkillCatalogRevisionToken({
    builtins: params.builtinSkills.map(({ checksum, skillKey, version }) => ({
      checksum,
      skillKey,
      version,
    })),
    platform: snapshot.tokenEntries,
  }).value;
  const { executionIndex, executionReady, payloadBytes } = indexExecutableSkills(
    skills,
    params.builtinSkills,
    platformResolvedByKey,
    projectionContainsInvalidItems,
  );
  const ready = executionReady && executionIndex.size === skills.length;
  cacheReadiness(revision, ready);
  const catalog = { revision, skills };
  const projectionKey = `${params.projectionSource}:${revision}`;
  storePublishedProjection(projectionKey, {
    catalog: cloneCatalog(catalog),
    executionIndex,
    executionReady: ready,
    payloadBytes,
    targetRevisionId: revision,
  });
  return projectionKey;
};
