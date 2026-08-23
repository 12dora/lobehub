import { z } from 'zod';

import {
  BOOTSTRAP_PASSWORD_MAX_LENGTH,
  BOOTSTRAP_PASSWORD_MIN_LENGTH,
} from '../../bootstrap/superAdmin';
import { strictDateSchema } from '../shared';
import { adminUserAssignableRoleNameSchema, reasonSchema, userIdSchema } from './common';

export const adminUsersBanInputSchema = z
  .object({
    expiresAt: strictDateSchema.optional(),
    reason: reasonSchema,
    userId: userIdSchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.expiresAt && val.expiresAt.getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expiresAt must be in the future',
        path: ['expiresAt'],
      });
    }
  });

export type AdminUsersBanInput = z.infer<typeof adminUsersBanInputSchema>;

export const adminUsersBanOutputSchema = z
  .object({
    banExpires: z.date().nullable(),
    banned: z.literal(true),
    userId: z.string(),
  })
  .strict();

export type AdminUsersBanOutput = z.infer<typeof adminUsersBanOutputSchema>;

export const adminUsersUnbanInputSchema = z
  .object({
    reason: reasonSchema,
    userId: userIdSchema,
  })
  .strict();

export type AdminUsersUnbanInput = z.infer<typeof adminUsersUnbanInputSchema>;

export const adminUsersUnbanOutputSchema = z
  .object({
    banned: z.literal(false),
    userId: z.string(),
  })
  .strict();

export type AdminUsersUnbanOutput = z.infer<typeof adminUsersUnbanOutputSchema>;

export const adminUsersRevokeSessionsInputSchema = z
  .object({
    /** When true, also revoke the actor's current session if actor === target. Default false. */
    includeCurrent: z.boolean().optional(),
    reason: reasonSchema,
    /**
     * Targeted revoke: revoke only these specific Better Auth session ids (must belong to
     * the target user). When present, the global security epoch is NOT advanced — only the
     * listed rows are deleted. Absent = revoke all sessions (existing behavior).
     */
    sessionIds: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
    userId: userIdSchema,
  })
  .strict();

export type AdminUsersRevokeSessionsInput = z.infer<typeof adminUsersRevokeSessionsInputSchema>;

export const adminUsersRevokeSessionsOutputSchema = z
  .object({
    revokedCount: z.number().int().nonnegative(),
    userId: z.string(),
  })
  .strict();

export type AdminUsersRevokeSessionsOutput = z.infer<typeof adminUsersRevokeSessionsOutputSchema>;

/**
 * Admin-provisioned credential (email + password) user. The password bounds mirror
 * Better Auth's `minPasswordLength` / `maxPasswordLength` in
 * `src/libs/better-auth/define-config.ts` so the user can change it later.
 * The password is input-only — it must never be echoed in outputs or audits.
 */
export const adminUsersCreateInputSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(255),
    fullName: z.string().trim().min(1).max(100),
    password: z.string().min(BOOTSTRAP_PASSWORD_MIN_LENGTH).max(BOOTSTRAP_PASSWORD_MAX_LENGTH),
    reason: reasonSchema,
    username: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[\w.-]+$/)
      .optional(),
  })
  .strict();

export type AdminUsersCreateInput = z.infer<typeof adminUsersCreateInputSchema>;

/** Never returns the password or its hash. */
export const adminUsersCreateOutputSchema = z
  .object({
    created: z.literal(true),
    email: z.string(),
    userId: z.string(),
  })
  .strict();

export type AdminUsersCreateOutput = z.infer<typeof adminUsersCreateOutputSchema>;

/**
 * Irreversible hard delete: removes the user row so every FK-cascade owned record
 * (sessions, accounts, messages, topics, agents, files, RBAC grants, …) is wiped.
 * Blocked for the actor's own account and the last permanent super admin.
 */
export const adminUsersDeleteInputSchema = z
  .object({
    reason: reasonSchema,
    userId: userIdSchema,
  })
  .strict();

export type AdminUsersDeleteInput = z.infer<typeof adminUsersDeleteInputSchema>;

export const adminUsersDeleteOutputSchema = z
  .object({
    deleted: z.literal(true),
    userId: z.string(),
  })
  .strict();

export type AdminUsersDeleteOutput = z.infer<typeof adminUsersDeleteOutputSchema>;

/**
 * Admin-set credential password. Bounds reuse Better Auth / bootstrap policy.
 * The password is input-only — never echoed in outputs or audits.
 */
export const adminUsersSetPasswordInputSchema = z
  .object({
    newPassword: z.string().min(BOOTSTRAP_PASSWORD_MIN_LENGTH).max(BOOTSTRAP_PASSWORD_MAX_LENGTH),
    /** Default true: advance the security epoch and drop live sessions. */
    revokeSessions: z.boolean().optional(),
    userId: userIdSchema,
  })
  .strict();

export type AdminUsersSetPasswordInput = z.infer<typeof adminUsersSetPasswordInputSchema>;

export const adminUsersSetPasswordOutputSchema = z
  .object({
    sessionsRevoked: z.boolean(),
    userId: z.string(),
  })
  .strict();

export type AdminUsersSetPasswordOutput = z.infer<typeof adminUsersSetPasswordOutputSchema>;

export const adminUsersDisableTwoFactorInputSchema = z
  .object({
    /** When true, also delete the target's passkey rows. Default false. */
    removePasskeys: z.boolean().optional(),
    userId: userIdSchema,
  })
  .strict();

export type AdminUsersDisableTwoFactorInput = z.infer<typeof adminUsersDisableTwoFactorInputSchema>;

export const adminUsersDisableTwoFactorOutputSchema = z
  .object({
    passkeysRemoved: z.boolean(),
    twoFactorEnabled: z.literal(false),
    userId: z.string(),
  })
  .strict();

export type AdminUsersDisableTwoFactorOutput = z.infer<
  typeof adminUsersDisableTwoFactorOutputSchema
>;

export const adminUsersReplaceGlobalRolesInputSchema = z
  .object({
    expiresAt: strictDateSchema.optional(),
    /**
     * Role names whose existing grants must be left untouched (expiry preserved) instead
     * of deleted + re-inserted. Used by single-role revoke so removing one role never
     * silently strips a time-boxed expiry from the remaining grants. Must be a subset of
     * roleNames.
     */
    preserveRoleNames: z.array(adminUserAssignableRoleNameSchema).max(16).optional(),
    reason: reasonSchema,
    roleNames: z.array(adminUserAssignableRoleNameSchema).max(16),
    userId: userIdSchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.expiresAt && val.expiresAt.getTime() <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expiresAt must be in the future',
        path: ['expiresAt'],
      });
    }

    if (new Set(val.roleNames).size !== val.roleNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'roleNames must not contain duplicates',
        path: ['roleNames'],
      });
    }

    if (val.preserveRoleNames) {
      if (new Set(val.preserveRoleNames).size !== val.preserveRoleNames.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'preserveRoleNames must not contain duplicates',
          path: ['preserveRoleNames'],
        });
      }
      const desired = new Set(val.roleNames);
      for (const roleName of val.preserveRoleNames) {
        if (!desired.has(roleName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'preserveRoleNames must be a subset of roleNames',
            path: ['preserveRoleNames'],
          });
          break;
        }
      }
    }
  });

export type AdminUsersReplaceGlobalRolesInput = z.infer<
  typeof adminUsersReplaceGlobalRolesInputSchema
>;

export const adminUsersReplaceGlobalRolesOutputSchema = z
  .object({
    expiresAt: z.date().nullable().optional(),
    roleNames: z.array(z.string()),
    userId: z.string(),
  })
  .strict();

export type AdminUsersReplaceGlobalRolesOutput = z.infer<
  typeof adminUsersReplaceGlobalRolesOutputSchema
>;
