import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import type { PlatformSkillResource } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { SkillManifest, SkillValidationResult } from '../../contracts/skillCatalog';
import { SkillCatalogNotFoundError } from './errors';
import type { BuiltinSkillDefinition } from './readService';
import { SkillCatalogReadService } from './readService';
import { SkillCatalogValidator } from './validator';

export interface SkillCatalogValidationOptions {
  allowBuiltinOverride?: boolean;
  builtinSkills?: BuiltinSkillDefinition[];
  knownToolKeys?: ReadonlySet<string>;
}

export interface SkillCatalogValidationPayload {
  allowBuiltinOverride: boolean;
  checksum: string;
  content: string;
  contentRef?: string | null;
  manifest: SkillManifest;
  resources?: PlatformSkillResource[];
  skillKey: string;
  version: string;
}

export class SkillCatalogValidationService {
  constructor(private readonly options: SkillCatalogValidationOptions = {}) {}

  validatePayload = async (
    db: LobeChatDatabase | Transaction,
    payload: SkillCatalogValidationPayload,
  ): Promise<SkillValidationResult> => {
    const readService = new SkillCatalogReadService(db, {
      builtinSkills: this.options.builtinSkills,
    });
    const validator = new SkillCatalogValidator({
      allowBuiltinOverride: this.options.allowBuiltinOverride,
      builtinSkillKeys: new Set((this.options.builtinSkills ?? []).map((skill) => skill.skillKey)),
      knownToolKeys: this.options.knownToolKeys ?? new Set(),
      resolveSkillDependency: async (skillKey, version) => {
        const resolved = await readService.resolveForExecution(skillKey, version);
        return resolved
          ? { manifest: resolved.manifest, skillKey: resolved.skillKey, version: resolved.version }
          : undefined;
      },
    });
    return validator.validate(payload);
  };

  validateStoredVersion = async (
    db: LobeChatDatabase | Transaction,
    skillId: string,
    versionId: string,
  ): Promise<SkillValidationResult> => {
    const repository = new PlatformSkillCatalogRepository(db);
    const [skill, version] = await Promise.all([
      repository.getSkill(skillId),
      repository.getVersion(skillId, versionId),
    ]);
    if (!skill || !version) throw new SkillCatalogNotFoundError();
    return this.validatePayload(db, {
      allowBuiltinOverride: skill.allowBuiltinOverride,
      checksum: version.checksum,
      content: version.content,
      contentRef: version.contentRef,
      manifest: version.manifest,
      resources: version.resources,
      skillKey: skill.skillKey,
      version: version.version,
    });
  };
}
