import { z } from 'zod';

import {
  boundedSafeText,
  checksumSchema,
  revisionSchema,
  skillContentRefSchema,
  skillKeySchema,
  skillVersionSchema,
} from './common';
import { skillManifestSchema, skillValidationResultSchema } from './manifest';
import { skillResourcesSchema } from './resources';

export const skillIdentityDraftSchema = z
  .object({
    allowBuiltinOverride: z.boolean(),
    currentVersionId: z.string().min(1).nullable(),
    description: boundedSafeText(4000).nullable(),
    displayName: boundedSafeText(200),
    distribution: z.enum(['mandatory', 'default', 'optional']),
    draftSequence: z.number().int().nonnegative(),
    enabled: z.boolean(),
    id: z.string().min(1),
    revision: revisionSchema,
    skillKey: skillKeySchema,
    source: z.enum(['builtin', 'uploaded']),
    status: z.enum(['draft', 'published', 'archived']),
  })
  .strict();

export const immutableSkillVersionSchema = z
  .object({
    checksum: checksumSchema,
    content: z.string().min(1).max(1_048_576),
    contentRef: skillContentRefSchema.nullable(),
    createdAt: z.date(),
    createdBy: z.string().min(1).nullable(),
    id: z.string().min(1),
    manifest: skillManifestSchema,
    resources: skillResourcesSchema,
    skillId: z.string().min(1),
    validation: skillValidationResultSchema.nullable(),
    version: skillVersionSchema,
  })
  .strict();

export const skillVersionSummarySchema = immutableSkillVersionSchema
  .omit({ content: true, contentRef: true, manifest: true, resources: true })
  .extend({ lastPublishedRevision: z.number().int().positive().nullable() })
  .strict();

export type ImmutableSkillVersion = z.infer<typeof immutableSkillVersionSchema>;
