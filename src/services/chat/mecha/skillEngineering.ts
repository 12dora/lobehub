import type { OperationSkillSet } from '@lobechat/context-engine';
import { SkillEngine } from '@lobechat/context-engine';
import { resourcesTreePrompt } from '@lobechat/prompts';
import type { AgentPluginMode, SkillItem } from '@lobechat/types';
import debug from 'debug';

import { isBuiltinSkillAvailableInCurrentEnv } from '@/helpers/toolAvailability';
import { agentSkillService } from '@/services/skill';
import { getToolStoreState } from '@/store/tool';
import { resolvePlatformSkillSelection } from '@/types/platform/skills';

const log = debug('context-engine:resolveClientSkills');

/**
 * Build the full content payload for a DB skill detail, appending its resource
 * tree when present (mirrors the activateSkill executor output).
 */
const buildDbSkillContent = (detail: SkillItem): string | undefined => {
  if (!detail.content) return undefined;

  const hasResources = !!(detail.resources && Object.keys(detail.resources).length > 0);
  return hasResources
    ? detail.content + '\n\n' + resourcesTreePrompt(detail.name, detail.resources!)
    : detail.content;
};

const buildPlatformSkillContent = (
  projection: Awaited<ReturnType<typeof agentSkillService.resolvePlatformPinned>>,
): string => {
  if (projection.resources.length === 0) return projection.content;
  const resources = Object.fromEntries(
    projection.resources.map((resource) => [
      resource.path,
      { content: resource.content, fileHash: resource.checksum, size: resource.sizeBytes },
    ]),
  );
  return `${projection.content}\n\n${resourcesTreePrompt(projection.name, resources)}`;
};

/**
 * Build a client-side OperationSkillSet via SkillEngine.
 *
 * Sources:
 * 1. Builtin skills (e.g., Artifacts) - from toolStore.builtinSkills
 * 2. DB skills (user/market) - from toolStore.agentSkills
 *
 * Pinned skills (ids in `pluginIds`) carry their full `content` so the
 * SkillContextProvider can inject it directly into the system prompt instead of
 * only listing them under `<available_skills>`. Builtin content is already in
 * memory; DB content is fetched on demand (store cache first) and only for the
 * pinned skills, to avoid bulk network calls when auto mode exposes every skill.
 *
 * Uses isBuiltinSkillAvailableInCurrentEnv as the enableChecker to
 * filter platform-specific skills (e.g., agent-browser on desktop only).
 */
export const resolveClientSkills = async (
  pluginIds?: string[],
  disabledIds?: string[],
): Promise<OperationSkillSet> => {
  const toolState = getToolStoreState();
  const pinnedIds = new Set(pluginIds ?? []);
  const disabledIdSet = new Set(disabledIds ?? []);

  const platformCatalog = toolState.platformSkillCatalog;
  if (platformCatalog) {
    const platformMetas = await Promise.all(
      platformCatalog.skills.map(async (skill) => {
        const mode: AgentPluginMode = disabledIdSet.has(skill.skillKey)
          ? 'disabled'
          : pinnedIds.has(skill.skillKey)
            ? 'pinned'
            : 'auto';
        const selection = resolvePlatformSkillSelection(skill.distribution, mode);
        if (!selection.available) return undefined;

        const meta = {
          description: skill.description ?? '',
          identifier: skill.skillKey,
          name: skill.displayName,
        };
        if (!selection.activated) return meta;

        // The authenticated legacy read projection is adapted server-side to
        // the same exact published resolver. Never fall back to personal data
        // when a managed catalog snapshot exists.
        const resolved = await agentSkillService.resolvePlatformPinned({
          checksum: skill.checksum,
          skillKey: skill.skillKey,
          version: skill.version,
        });
        if (
          resolved.identifier !== skill.skillKey ||
          resolved.version !== skill.version ||
          resolved.checksum !== skill.checksum
        ) {
          throw new Error(`Published Skill ${skill.skillKey} could not be resolved exactly`);
        }
        return { ...meta, activated: true, content: buildPlatformSkillContent(resolved) };
      }),
    );
    const skills = platformMetas.filter((skill) => skill !== undefined);
    const skillEngine = new SkillEngine({ skills });
    const operation = skillEngine.generate(pluginIds ?? []);
    return {
      ...operation,
      platformCatalog: {
        refs: platformCatalog.skills
          .filter((skill) => skills.some((candidate) => candidate.identifier === skill.skillKey))
          .map(({ checksum, skillKey, version }) => ({ checksum, skillKey, version })),
        revision: platformCatalog.revision,
      },
    };
  }

  // Builtin skills keep their full content in the store, so it is always cheap
  // to carry along. Pinned skills are marked `activated` so SkillContextProvider
  // injects their content directly; non-pinned ones stay in <available_skills>.
  // Disabled skills are dropped from the candidate pool entirely — not just
  // left unpinned — so a disabled skill is neither listed nor resolvable by
  // name via `activateSkill`.
  const builtinMetas = (toolState.builtinSkills || [])
    .filter((s) => !disabledIdSet.has(s.identifier))
    .map((s) => ({
      activated: pinnedIds.has(s.identifier) && !!s.content,
      content: s.content,
      description: s.description,
      identifier: s.identifier,
      name: s.name,
    }));

  const dbMetas = await Promise.all(
    (toolState.agentSkills || [])
      .filter((s) => !disabledIdSet.has(s.identifier))
      .map(async (s) => {
        const meta = {
          description: s.description ?? '',
          identifier: s.identifier,
          name: s.name,
        };

        // Only pinned DB skills need full content for direct injection; the list
        // query (SkillListItem) does not carry content, so fetch it on demand.
        if (!pinnedIds.has(s.identifier)) return meta;

        // Skills bundled as a ZIP (scripts/resources) must be activated via the
        // activateSkill tool so the server mounts their bundle for execScript /
        // readReference — that runtime mount is keyed off stepContext.activatedSkills,
        // which operation-level pinning does not populate. Pre-injecting their
        // content would instruct the model to run scripts from an unmounted bundle,
        // so leave bundled skills in <available_skills> and let the model activate them.
        if (s.zipFileHash) return meta;

        try {
          const detail =
            toolState.agentSkillDetailMap?.[s.id] ?? (await agentSkillService.getById(s.id));
          const content = detail && buildDbSkillContent(detail);
          // Mark activated only when content is available, otherwise the skill would
          // be excluded from both the activated and the <available_skills> lists.
          return content ? { ...meta, activated: true, content } : meta;
        } catch (error) {
          // A single skill's content fetch must never break the whole request;
          // degrade gracefully by listing the skill without injected content.
          log('Failed to load content for pinned skill %s: %O', s.identifier, error);
          return meta;
        }
      }),
  );

  const skillEngine = new SkillEngine({
    enableChecker: (skill) => isBuiltinSkillAvailableInCurrentEnv(skill.identifier),
    skills: [...builtinMetas, ...dbMetas],
  });

  return skillEngine.generate(pluginIds ?? []);
};
