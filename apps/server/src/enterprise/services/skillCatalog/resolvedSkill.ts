import type { z } from 'zod';

import type { PlatformPublishedSkillView } from '@/database/models/platform';
import { platformSkillVersionChecksum } from '@/database/models/platform';

import {
  type PlatformSkillPinnedRef,
  type PublishedSkill,
  serverResolvedSkillSchema,
  type SkillManifest,
  type SkillResource,
} from '../../contracts/skillCatalog';

export type ResolvedSkill = z.infer<typeof serverResolvedSkillSchema>;

export interface BuiltinSkillDefinition extends PublishedSkill {
  content: string;
  contentRef?: string | null;
  manifest: SkillManifest;
  resources?: SkillResource[];
}

export const exactRefKey = ({ checksum, skillKey, version }: PlatformSkillPinnedRef) =>
  `${skillKey}\0${version}\0${checksum}`;

export const isCanonicalExactResolution = (ref: PlatformSkillPinnedRef, resolved: ResolvedSkill) =>
  resolved.skillKey === ref.skillKey &&
  resolved.version === ref.version &&
  resolved.checksum === ref.checksum &&
  platformSkillVersionChecksum({
    content: resolved.content,
    contentRef: resolved.contentRef,
    manifest: resolved.manifest,
    resources: resolved.resources,
  }) === ref.checksum;

export const parseResolvedBuiltinSkill = (builtin: {
  checksum: string;
  content: string;
  contentRef?: string | null;
  description: PublishedSkill['description'];
  displayName: string;
  distribution: PublishedSkill['distribution'];
  manifest: SkillManifest;
  resources?: SkillResource[];
  skillKey: string;
  version: string;
}): ResolvedSkill =>
  serverResolvedSkillSchema.parse({
    allowBuiltinOverride: false,
    checksum: builtin.checksum,
    content: builtin.content,
    contentRef: builtin.contentRef ?? null,
    description: builtin.description,
    displayName: builtin.displayName,
    distribution: builtin.distribution,
    manifest: builtin.manifest,
    resources: builtin.resources ?? [],
    skillId: `builtin:${builtin.skillKey}`,
    skillKey: builtin.skillKey,
    source: 'builtin',
    version: builtin.version,
    versionId: `builtin:${builtin.skillKey}@${builtin.version}`,
  });

export const parseResolvedPlatformSkill = (item: PlatformPublishedSkillView): ResolvedSkill =>
  serverResolvedSkillSchema.parse({
    allowBuiltinOverride: item.allowBuiltinOverride,
    checksum: item.version.checksum,
    content: item.version.content,
    contentRef: item.version.contentRef,
    description: item.description,
    displayName: item.displayName,
    distribution: item.distribution,
    manifest: item.version.manifest,
    resources: item.version.resources,
    skillId: item.skillId,
    skillKey: item.skillKey,
    source: item.source,
    version: item.version.version,
    versionId: item.version.id,
  });
