import { z } from 'zod';

import {
  boundedSafeText,
  checksumSchema,
  skillContentRefSchema,
  skillKeySchema,
  skillVersionSchema,
} from './common';
import { skillManifestSchema } from './manifest';
import { skillResourcesSchema } from './resources';

export const publishedSkillSchema = z
  .object({
    checksum: checksumSchema,
    description: boundedSafeText(4000).nullable(),
    displayName: boundedSafeText(200),
    distribution: z.enum(['mandatory', 'default', 'optional']),
    skillKey: skillKeySchema,
    source: z.enum(['builtin', 'uploaded']),
    version: skillVersionSchema,
  })
  .strict();

export const publishedSkillCatalogSchema = z
  .object({
    revision: z.string().min(1).max(200),
    skills: z.array(publishedSkillSchema),
  })
  .strict();

export const platformSkillPinnedRefSchema = z
  .object({
    checksum: checksumSchema,
    skillKey: skillKeySchema,
    version: skillVersionSchema,
  })
  .strict();

export const platformSkillOperationProofSchema = z
  .object({
    agentId: z.string().min(1).max(256),
    operationId: z.string().min(1).max(256),
    proof: z.string().min(1).max(8192),
    refs: z.array(platformSkillPinnedRefSchema).max(10_000),
    revision: z.string().min(1).max(200),
  })
  .strict();

export const beginPlatformSkillOperationInputSchema = platformSkillOperationProofSchema
  .omit({ proof: true })
  .strict();

export const resolvePlatformSkillPinnedInputSchema = z
  .object({
    operation: platformSkillOperationProofSchema.optional(),
    ref: platformSkillPinnedRefSchema,
  })
  .strict();

/** Server-only execution projection. Never return this schema from a public/admin router. */
export const serverResolvedSkillSchema = publishedSkillSchema
  .extend({
    allowBuiltinOverride: z.boolean(),
    content: z.string().min(1).max(1_048_576),
    contentRef: skillContentRefSchema.nullable(),
    manifest: skillManifestSchema,
    resources: skillResourcesSchema,
    skillId: z.string().min(1),
    versionId: z.string().min(1),
  })
  .strict();

export type PlatformSkillPinnedRef = z.infer<typeof platformSkillPinnedRefSchema>;
export type PublishedSkill = z.infer<typeof publishedSkillSchema>;
