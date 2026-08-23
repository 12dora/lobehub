import { z } from 'zod';

import { skillKeySchema, skillVersionSchema } from './common';
import { skillManifestSchema } from './manifest';
import { skillResourcesSchema } from './resources';

/** Parse a skill package from URL / GitHub repo / uploaded ZIP without persisting anything. */
export const adminSkillParseImportSourceInputSchema = z.discriminatedUnion('source', [
  z
    .object({
      source: z.literal('url'),
      url: z
        .string()
        .trim()
        .min(1)
        .max(2048)
        .refine((value) => {
          try {
            const parsed = new URL(value);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
          } catch {
            return false;
          }
        }, 'url must be a valid http(s) URL'),
    })
    .strict(),
  z
    .object({
      /** Same formats the user GitHub importer accepts: owner/repo, github.com/owner/repo[/tree|blob/...]. */
      repoUrl: z.string().trim().min(1).max(2048),
      source: z.literal('github'),
    })
    .strict(),
  z
    .object({
      fileName: z.string().trim().min(1).max(255),
      source: z.literal('zip'),
      /** Base64-encoded ZIP payload; decoded size is capped at 20MB by the handler. */
      zipBase64: z.string().min(1).max(30_000_000),
    })
    .strict(),
]);

export const adminSkillParseImportSourceOutputSchema = z
  .object({
    content: z.string().max(1_048_576),
    description: z.string().max(4000).nullable(),
    displayName: z.string().min(1).max(200),
    /**
     * Enterprise platform Skill manifest derived from the package metadata.
     * Callers must publish this rather than synthesizing an empty-permissions stub.
     */
    manifest: skillManifestSchema,
    /**
     * Package SemVer when present and valid; omit when absent/invalid so clients can default.
     */
    packageVersion: skillVersionSchema.optional(),
    resources: skillResourcesSchema,
    /** true when parsed resources were dropped (count cap, binary/oversize file or invalid path). */
    resourcesTruncated: z.boolean().optional(),
    sourceMeta: z
      .object({
        kind: z.enum(['github', 'url', 'zip']),
        origin: z.string().min(1).max(2048),
      })
      .strict()
      .optional(),
    suggestedSkillKey: skillKeySchema,
  })
  .strict();

export type AdminSkillParseImportSourceInput = z.infer<
  typeof adminSkillParseImportSourceInputSchema
>;
export type AdminSkillParseImportSourceOutput = z.infer<
  typeof adminSkillParseImportSourceOutputSchema
>;
