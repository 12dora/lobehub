import { checksumPayload, PlatformSkillCatalogModel } from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { PublishedSkill, SkillManifest, SkillResource } from '../../contracts/skillCatalog';

export interface BuiltinSkillDefinition extends PublishedSkill {
  content: string;
  contentRef?: string | null;
  manifest: SkillManifest;
  resources?: SkillResource[];
}

export interface SkillCatalogReadOptions {
  builtinSkills?: BuiltinSkillDefinition[];
}

export const getEmptyPublishedSkillCatalog = () => ({ revision: 'disabled', skills: [] });

const compareCodepoint = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export class SkillCatalogReadService {
  private readonly model: PlatformSkillCatalogModel;

  constructor(
    db: LobeChatDatabase | Transaction,
    private readonly options: SkillCatalogReadOptions = {},
  ) {
    this.model = new PlatformSkillCatalogModel(db);
  }

  getPublishedCatalog = async () => {
    const page = await this.model.listPublished({ limit: 100 });
    const builtins = new Map(
      (this.options.builtinSkills ?? []).map((skill) => [skill.skillKey, skill] as const),
    );
    const platformSkills: PublishedSkill[] = [];
    for (const item of page.items) {
      if (builtins.has(item.skillKey) && !item.allowBuiltinOverride) continue;
      platformSkills.push({
        checksum: item.version.checksum,
        description: item.description,
        displayName: item.displayName,
        distribution: item.distribution,
        skillKey: item.skillKey,
        source: item.source,
        version: item.version.version,
      });
    }

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
    return {
      revision: checksumPayload(
        page.items.map(({ revision, skillId, version }) => ({
          checksum: version.checksum,
          revision,
          skillId,
        })),
      ),
      skills,
    };
  };

  resolveForExecution = async (skillKey: string, version?: string) => {
    const builtin = this.options.builtinSkills?.find((item) => item.skillKey === skillKey);
    const platform = await this.model.resolvePublishedVersion(skillKey, version);
    if (platform && (!builtin || platform.allowBuiltinOverride)) {
      return {
        allowBuiltinOverride: platform.allowBuiltinOverride,
        checksum: platform.version.checksum,
        content: platform.version.content,
        contentRef: platform.version.contentRef,
        description: platform.description,
        displayName: platform.displayName,
        distribution: platform.distribution,
        manifest: platform.version.manifest,
        resources: platform.version.resources,
        skillId: platform.skillId,
        skillKey: platform.skillKey,
        source: platform.source,
        version: platform.version.version,
        versionId: platform.version.id,
      };
    }
    if (version) {
      if (builtin?.version === version) {
        return {
          ...builtin,
          allowBuiltinOverride: false,
          contentRef: builtin.contentRef ?? null,
          resources: builtin.resources ?? [],
          skillId: `builtin:${builtin.skillKey}`,
          versionId: `builtin:${builtin.skillKey}@${builtin.version}`,
        };
      }
      return undefined;
    }

    if (!builtin) return undefined;
    return {
      ...builtin,
      allowBuiltinOverride: false,
      contentRef: builtin.contentRef ?? null,
      resources: builtin.resources ?? [],
      skillId: `builtin:${builtin.skillKey}`,
      versionId: `builtin:${builtin.skillKey}@${builtin.version}`,
    };
  };
}
