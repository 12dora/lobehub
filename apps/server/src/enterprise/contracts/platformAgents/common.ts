import { PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY } from '@lobechat/types';
import { z } from 'zod';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import { isStrictSemVer } from '../shared';

export const addSecretIssue = (value: string, ctx: z.RefinementCtx) => {
  if (containsEnterpriseSecretMaterial(value)) {
    ctx.addIssue({ code: 'custom', message: 'secret material is not allowed' });
  }
};

export const safeText = (max: number, min = 0) =>
  z.string().trim().min(min).max(max).superRefine(addSecretIssue);

export const idSchema = z.string().trim().min(1).max(128);
export const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const revisionSchema = z.number().int().nonnegative();
export const positiveRevisionSchema = z.number().int().positive();
export const reasonSchema = safeText(2000, 1);
/**
 * Audit reason for operations the admin console no longer prompts for (assignment edits,
 * rollouts, rollback, default switch). Accepted and recorded when a caller supplies one;
 * omitted rows simply carry no reason.
 */
export const optionalReasonSchema = reasonSchema.optional();
export const draftTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const platformAgentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const platformAgentVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isStrictSemVer, 'version must be valid SemVer');

export const platformAgentSystemKeySchema = z
  .literal(PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY)
  .nullable();

export const platformAgentModelParametersSchema = z
  .object({
    frequencyPenalty: z.number().finite().min(-2).max(2).optional(),
    maxTokens: z.number().int().positive().max(10_000_000).optional(),
    presencePenalty: z.number().finite().min(-2).max(2).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    topP: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

export const uniqueStringsSchema = (item: z.ZodType<string>, max: number) =>
  z
    .array(item)
    .max(max)
    .superRefine((values, ctx) => {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: 'custom', message: 'values must be unique' });
      }
    });

export const platformAgentVersionConfigSchema = z
  .object({
    avatar: safeText(2048, 1).nullable(),
    backgroundColor: z
      .string()
      .trim()
      .regex(/^#[a-f0-9]{6}$/i)
      .nullable(),
    description: safeText(4000, 1).nullable(),
    displayName: safeText(200, 1),
    modelParameters: platformAgentModelParametersSchema,
    openingMessage: safeText(8000, 1).nullable(),
    openingQuestions: uniqueStringsSchema(safeText(1000, 1), 50),
    // Empty is valid: the legacy inbox default is `""`, and admins may publish no prompt.
    systemRole: safeText(100_000),
    tags: uniqueStringsSchema(safeText(100, 1), 50),
  })
  .strict();

export const platformAgentModelDependencyRefSchema = z
  .object({
    modelKey: safeText(150, 1),
    providerChecksum: checksumSchema,
    providerKey: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    providerRevision: positiveRevisionSchema,
  })
  .strict();

export const platformAgentSkillDependencyRefSchema = z
  .object({
    checksum: checksumSchema,
    skillKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    version: platformAgentVersionSchema,
  })
  .strict();

const connectorToolKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][\w.:/-]{0,199}$/u);

export const platformAgentConnectorDependencyRefSchema = z
  .object({
    allowedToolKeys: uniqueStringsSchema(connectorToolKeySchema, 1000),
    connectorId: idSchema,
    connectorKey: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9._-]*$/),
    publishedChecksum: checksumSchema,
    publishedRevision: positiveRevisionSchema,
  })
  .strict();

export const platformAgentDependencySnapshotSchema = z
  .object({
    connectors: z.array(platformAgentConnectorDependencyRefSchema).max(100),
    model: platformAgentModelDependencyRefSchema,
    skills: z.array(platformAgentSkillDependencyRefSchema).max(100),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const connectorKeys = snapshot.connectors.map(({ connectorKey }) => connectorKey);
    if (new Set(connectorKeys).size !== connectorKeys.length) {
      ctx.addIssue({ code: 'custom', message: 'connector references must be unique' });
    }
    const skillKeys = snapshot.skills.map(({ skillKey }) => skillKey);
    if (new Set(skillKeys).size !== skillKeys.length) {
      ctx.addIssue({ code: 'custom', message: 'skill references must be unique' });
    }
  });
