import type { SkillItem, SkillListItem, SkillResourceContent } from '@lobechat/types';

import { getToolStoreState } from '@/store/tool';

import { agentSkillService } from './skill';

const PLATFORM_SKILL_ID_PREFIX = 'platform-skill:';

const runtimeId = (ref: { checksum: string; skillKey: string; version: string }) =>
  `${PLATFORM_SKILL_ID_PREFIX}${ref.skillKey}@${ref.version}#${ref.checksum}`;

const getPublishedRef = (identifier: string) => {
  const catalog = getToolStoreState().platformSkillCatalog;
  if (!catalog) return undefined;
  const skill = catalog.skills.find((item) => item.skillKey === identifier);
  if (!skill) throw new Error(`Managed Skill is not published: ${identifier}`);
  return skill;
};

const resolvePublished = async (identifier: string): Promise<SkillItem | undefined> => {
  const published = getPublishedRef(identifier);
  if (!published) return undefined;
  const resolved = await agentSkillService.resolvePlatformPinned({
    checksum: published.checksum,
    skillKey: published.skillKey,
    version: published.version,
  });
  if (
    resolved.identifier !== published.skillKey ||
    resolved.version !== published.version ||
    resolved.checksum !== published.checksum
  ) {
    throw new Error(`Published Skill ${published.skillKey} could not be resolved exactly`);
  }
  return {
    content: resolved.content,
    createdAt: new Date(0),
    description: resolved.description,
    id: runtimeId(published),
    identifier: published.skillKey,
    manifest: {
      description: resolved.description ?? '',
      name: published.skillKey,
      version: published.version,
    },
    name: resolved.name,
    resources: Object.fromEntries(
      resolved.resources.map((resource) => [
        resource.path,
        {
          content: resource.content,
          fileHash: resource.checksum,
          size: resource.sizeBytes,
        },
      ]),
    ),
    source: 'user',
    updatedAt: new Date(0),
  };
};

/** Dynamic adapter: exact Published Catalog when managed, untouched legacy reads otherwise. */
export const clientSkillRuntimeService = {
  findAll: async (): Promise<{ data: SkillListItem[]; total: number }> => {
    const catalog = getToolStoreState().platformSkillCatalog;
    if (!catalog) return agentSkillService.list();
    const data: SkillListItem[] = catalog.skills.map((skill) => ({
      createdAt: new Date(0),
      description: skill.description,
      id: runtimeId(skill),
      identifier: skill.skillKey,
      manifest: {
        description: skill.description ?? '',
        name: skill.skillKey,
        version: skill.version,
      },
      name: skill.displayName,
      source: 'user',
      updatedAt: new Date(0),
    }));
    return { data, total: data.length };
  },
  findById: async (id: string): Promise<SkillItem | undefined> => {
    const catalog = getToolStoreState().platformSkillCatalog;
    if (!catalog) return agentSkillService.getById(id);
    const published = catalog.skills.find((skill) => runtimeId(skill) === id);
    if (!published) throw new Error(`Managed Skill is not published: ${id}`);
    return resolvePublished(published.skillKey);
  },
  findByName: async (name: string): Promise<SkillItem | undefined> => {
    if (!getToolStoreState().platformSkillCatalog) return agentSkillService.getByName(name);
    return resolvePublished(name);
  },
  readResource: async (id: string, path: string): Promise<SkillResourceContent> => {
    const catalog = getToolStoreState().platformSkillCatalog;
    if (!catalog) return agentSkillService.readResource(id, path);
    const published = catalog.skills.find((skill) => runtimeId(skill) === id);
    if (!published) throw new Error(`Managed Skill is not published: ${id}`);
    const resolved = await resolvePublished(published.skillKey);
    const resource = resolved?.resources?.[path];
    if (resource?.content === undefined) {
      throw new Error(`Platform Skill resource is unavailable: ${path}`);
    }
    return {
      content: resource.content,
      encoding: 'utf8',
      fileHash: resource.fileHash,
      fileType: 'text/plain',
      path,
      size: resource.size,
    };
  },
};
