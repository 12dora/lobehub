import type { SkillItem, SkillListItem, SkillResourceContent } from '@lobechat/types';
import {
  indexPlatformSkillRefs,
  PLATFORM_SKILL_ID_PREFIX,
  PlatformSkillInFlightCache,
  platformSkillRuntimeId,
  toPlatformSkillListItem,
  toPlatformSkillResourceContent,
} from '@lobechat/types';

import { getToolStoreState } from '@/store/tool';
import type {
  PlatformSkillOperationSnapshot,
  PlatformSkillPinnedRef,
} from '@/types/platform/skills';

import { agentSkillService } from './skill';

const getRuntimeCatalog = () => {
  const state = getToolStoreState();
  if (state.platformSkillRuntimeStatus === 'unmanaged') return undefined;
  if (state.platformSkillRuntimeStatus !== 'ready' || !state.platformSkillCatalog) {
    throw new Error('Managed Skill runtime catalog is unavailable');
  }
  return state.platformSkillCatalog;
};

const freezeCanonicalSkillItem = (skill: SkillItem): Readonly<SkillItem> => {
  if (skill.resources) {
    for (const resource of Object.values(skill.resources)) Object.freeze(resource);
    Object.freeze(skill.resources);
  }
  if (skill.manifest) Object.freeze(skill.manifest);
  return Object.freeze(skill);
};

const getPublishedRef = (identifier: string) => {
  const catalog = getRuntimeCatalog();
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
    id: platformSkillRuntimeId(published),
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

const resolveExactRef = async (
  ref: PlatformSkillPinnedRef,
  metadata?: { description?: string | null; displayName?: string },
  snapshot?: PlatformSkillOperationSnapshot,
): Promise<SkillItem> => {
  const resolved = await agentSkillService.resolvePlatformPinned(ref, snapshot);
  if (
    resolved.identifier !== ref.skillKey ||
    resolved.version !== ref.version ||
    resolved.checksum !== ref.checksum
  ) {
    throw new Error(`Published Skill ${ref.skillKey} could not be resolved exactly`);
  }
  return {
    content: resolved.content,
    createdAt: new Date(0),
    description: metadata?.description ?? resolved.description,
    id: platformSkillRuntimeId(ref),
    identifier: ref.skillKey,
    manifest: {
      description: resolved.description ?? '',
      name: ref.skillKey,
      version: ref.version,
    },
    name: metadata?.displayName ?? resolved.name,
    resources: Object.fromEntries(
      resolved.resources.map((resource) => [
        resource.path,
        { content: resource.content, fileHash: resource.checksum, size: resource.sizeBytes },
      ]),
    ),
    source: 'user',
    updatedAt: new Date(0),
  };
};

/** Dynamic adapter: exact Published Catalog when managed, untouched legacy reads otherwise. */
export const clientSkillRuntimeService = {
  findAll: async (): Promise<{ data: SkillListItem[]; total: number }> => {
    const catalog = getRuntimeCatalog();
    if (!catalog) return agentSkillService.list();
    const data: SkillListItem[] = catalog.skills.map((skill) => ({
      createdAt: new Date(0),
      description: skill.description,
      id: platformSkillRuntimeId(skill),
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
    const catalog = getRuntimeCatalog();
    if (!catalog) return agentSkillService.getById(id);
    const published = catalog.skills.find((skill) => platformSkillRuntimeId(skill) === id);
    if (!published) throw new Error(`Managed Skill is not published: ${id}`);
    return resolvePublished(published.skillKey);
  },
  findByName: async (name: string): Promise<SkillItem | undefined> => {
    if (!getRuntimeCatalog()) return agentSkillService.getByName(name);
    return resolvePublished(name);
  },
  readResource: async (id: string, path: string): Promise<SkillResourceContent> => {
    const catalog = getRuntimeCatalog();
    if (!catalog) return agentSkillService.readResource(id, path);
    const published = catalog.skills.find((skill) => platformSkillRuntimeId(skill) === id);
    if (!published) throw new Error(`Managed Skill is not published: ${id}`);
    const resolved = await resolvePublished(published.skillKey);
    const resource = resolved?.resources?.[path];
    const content = resource?.content;
    if (content === undefined || !resource) {
      throw new Error(`Platform Skill resource is unavailable: ${path}`);
    }
    return toPlatformSkillResourceContent(path, {
      content,
      fileHash: resource.fileHash,
      size: resource.size,
    });
  },
};

/** Exact operation-scoped runtime; it never consults the moving global catalog. */
export const createClientSkillRuntimeService = (snapshot?: PlatformSkillOperationSnapshot) => {
  if (!snapshot) return clientSkillRuntimeService;
  const frozen = structuredClone(snapshot);
  const { byId: refsById, byKey: refsByKey } = indexPlatformSkillRefs(frozen.refs);
  const metadataByKey = new Map(frozen.skills?.map((skill) => [skill.skillKey, skill]));
  // Successful values stay as settled promises; rejections are evicted by PlatformSkillInFlightCache.
  const cache = new PlatformSkillInFlightCache<Readonly<SkillItem>>();
  const resolve = (ref: PlatformSkillPinnedRef) => {
    const key = platformSkillRuntimeId(ref);
    const existing = cache.get(key);
    if (existing) return existing.then((skill) => structuredClone(skill) as SkillItem);
    const pending = cache.set(
      key,
      resolveExactRef(ref, metadataByKey.get(ref.skillKey), frozen).then((skill) =>
        freezeCanonicalSkillItem(structuredClone(skill)),
      ),
    );
    return pending.then((skill) => structuredClone(skill) as SkillItem);
  };
  return {
    findAll: async (): Promise<{ data: SkillListItem[]; total: number }> => {
      const data = [...refsByKey.values()].map((ref) =>
        toPlatformSkillListItem(ref, metadataByKey.get(ref.skillKey)),
      );
      return { data, total: data.length };
    },
    findById: async (id: string) => {
      const ref = refsById.get(id);
      return ref ? resolve(ref) : undefined;
    },
    findByName: async (name: string) => {
      const ref = refsByKey.get(name);
      return ref ? resolve(ref) : undefined;
    },
    readResource: async (id: string, path: string): Promise<SkillResourceContent> => {
      const ref = refsById.get(id);
      if (!ref) throw new Error(`Managed Skill is not published: ${id}`);
      const skill = await resolve(ref);
      const resource = skill.resources?.[path];
      const content = resource?.content;
      if (content === undefined || !resource) {
        throw new Error(`Platform Skill resource is unavailable: ${path}`);
      }
      return toPlatformSkillResourceContent(path, {
        content,
        fileHash: resource.fileHash,
        size: resource.size,
      });
    },
  };
};

export { PLATFORM_SKILL_ID_PREFIX, platformSkillRuntimeId };
