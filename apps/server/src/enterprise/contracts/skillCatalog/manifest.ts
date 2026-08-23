import { z } from 'zod';

import { boundedSafeText, localizedTextSchema, skillKeySchema, skillVersionSchema } from './common';

export const skillToolDependencySchema = z
  .object({
    optional: z.boolean().default(false),
    toolKey: z.string().trim().min(1).max(128),
  })
  .strict();

export const skillSkillDependencySchema = z
  .object({
    optional: z.boolean().default(false),
    skillKey: skillKeySchema,
    version: skillVersionSchema,
  })
  .strict();

export const skillPermissionsSchema = z
  .object({
    filesystem: z.enum(['none', 'read']).default('none'),
    network: z
      .object({
        allowedHosts: z
          .array(
            z
              .string()
              .trim()
              .min(1)
              .max(253)
              .regex(
                /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
              ),
          )
          .max(50),
        enabled: z.boolean(),
      })
      .strict()
      .default({ allowedHosts: [], enabled: false }),
    tools: z
      .object({ allow: z.array(z.string().trim().min(1).max(128)).max(100) })
      .strict()
      .default({ allow: [] }),
  })
  .strict();

export const skillManifestSchema = z
  .object({
    description: boundedSafeText(4000),
    displayName: boundedSafeText(200),
    localizedDescriptions: localizedTextSchema.default({}),
    localizedDisplayNames: localizedTextSchema.default({}),
    permissions: skillPermissionsSchema,
    skillDependencies: z.array(skillSkillDependencySchema).max(100).default([]),
    toolDependencies: z.array(skillToolDependencySchema).max(100).default([]),
  })
  .strict();

export const skillValidationIssueCodeSchema = z.enum([
  'builtin_override_forbidden',
  'checksum_mismatch',
  'content_too_large',
  'dangerous_instruction',
  'dependency_cycle',
  'dependency_graph_limit',
  'dependency_identity_mismatch',
  'dependency_resolver_error',
  'manifest_invalid',
  /** Opaque contentRef / non-inline resources are not executable by the managed Skill runtime. */
  'non_inline_content',
  'permissions_invalid',
  'secret_material_detected',
  'unknown_skill_dependency',
  'unknown_tool_dependency',
  'version_conflict',
]);

export const skillValidationIssueSchema = z
  .object({
    code: skillValidationIssueCodeSchema,
    message: boundedSafeText(500),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).max(32),
    severity: z.enum(['error', 'warning']),
  })
  .strict();

export const skillValidationResultSchema = z
  .object({
    issues: z.array(skillValidationIssueSchema).max(500),
    validatedAt: z.date(),
    validatorVersion: z.string().min(1).max(64),
  })
  .strict();

export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type SkillValidationIssue = z.infer<typeof skillValidationIssueSchema>;
export type SkillValidationResult = z.infer<typeof skillValidationResultSchema>;
