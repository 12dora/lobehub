import { createHash } from 'node:crypto';

import { z } from 'zod';

import { checksumSchema, skillContentRefSchema, skillResourcePathSchema } from './common';

/** SHA-256 hex digest of UTF-8 content bytes (resource integrity). */
export const skillResourceContentChecksum = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

export const skillResourceSchema = z
  .object({
    checksum: checksumSchema,
    content: z.string().max(1_048_576).optional(),
    contentRef: skillContentRefSchema.optional(),
    mediaType: z
      .string()
      .trim()
      .min(3)
      .max(127)
      .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/),
    path: skillResourcePathSchema,
    sizeBytes: z.number().int().nonnegative().max(1_048_576),
  })
  .strict()
  .superRefine((resource, ctx) => {
    if ((resource.content === undefined) === (resource.contentRef === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'resource must contain exactly one of content or contentRef',
      });
    }
    if (resource.content !== undefined) {
      const contentBytes = new TextEncoder().encode(resource.content);
      if (contentBytes.byteLength !== resource.sizeBytes) {
        ctx.addIssue({
          code: 'custom',
          message: 'resource sizeBytes must match UTF-8 content bytes',
          path: ['sizeBytes'],
        });
      }
      // Bind checksum to actual content bytes — syntax-only digests must not pass.
      const digest = skillResourceContentChecksum(resource.content);
      if (digest !== resource.checksum) {
        ctx.addIssue({
          code: 'custom',
          message: 'resource checksum must match SHA-256 of UTF-8 content',
          path: ['checksum'],
        });
      }
    }
  });

export const skillResourcesSchema = z.array(skillResourceSchema).max(100);

export type SkillResource = z.infer<typeof skillResourceSchema>;
