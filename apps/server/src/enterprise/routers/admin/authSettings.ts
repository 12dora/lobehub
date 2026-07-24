import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PlatformAuthSettingsModel } from '@/database/models/platform';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import type { LobeChatDatabase } from '@/database/type';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import {
  EMAIL_DOMAIN_PATTERN,
  normalizeEmailDomainAllowlist,
  platformAuthSettingsSchema,
} from '@/types/platform/authSettings';

import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { withPlatformPermission } from '../../guards/platformPermission';
import { PlatformAuditService } from '../../services/platformAudit';

const authSettingsBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

/**
 * Local CAS schemas until the contracts batch promotes `revision` /
 * `expectedRevision` into shared `adminAuthSettings*` contracts.
 * Shared `platformAuthSettingsSchema` is `.strict()` so extra CAS keys cannot be
 * composed via `.and()`; define full local schemas here instead.
 */
const domainEntrySchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(EMAIL_DOMAIN_PATTERN, { message: 'INVALID_EMAIL_DOMAIN' });

const authSettingsGetOutputSchema = z
  .object({
    emailDomainAllowlist: z.array(domainEntrySchema).max(200),
    emailDomainAllowlistEnabled: z.boolean(),
    openRegistration: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

/** Full document + CAS token (matches previous full-document update contract). */
const authSettingsUpdateInputSchema = z
  .object({
    emailDomainAllowlist: z.array(domainEntrySchema).max(200),
    emailDomainAllowlistEnabled: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
    openRegistration: z.boolean(),
  })
  .strict();

const authSettingsUpdateOutputSchema = authSettingsGetOutputSchema;

/**
 * Platform authentication / registration settings (M15).
 * Direct-save: `update` persists the whole document immediately (no draft/publish).
 * Gated on IDENTITY_* — registration policy is identity/login-adjacent.
 *
 * Config write + success audit share one DB transaction so an unavailable audit sink
 * cannot leave an unaudited committed change (fail closed). CAS via `revision`.
 */
export const adminAuthSettingsRouter = router({
  get: authSettingsBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_READ))
    .output(authSettingsGetOutputSchema)
    .query(async ({ ctx }) => new PlatformAuthSettingsModel(ctx.serverDB).get()),

  update: authSettingsBase
    .use(withPlatformPermission(PLATFORM_PERMISSIONS.IDENTITY_UPDATE))
    .input(authSettingsUpdateInputSchema)
    .output(authSettingsUpdateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.serverDB.transaction(async (tx) => {
          const { expectedRevision, ...settingsPatch } = input;
          const parsed = platformAuthSettingsSchema.parse({
            emailDomainAllowlist: normalizeEmailDomainAllowlist(settingsPatch.emailDomainAllowlist),
            emailDomainAllowlistEnabled: settingsPatch.emailDomainAllowlistEnabled,
            openRegistration: settingsPatch.openRegistration,
          });

          const next = await new PlatformAuthSettingsModel(
            tx as unknown as LobeChatDatabase,
          ).update(ctx.userId!, { ...parsed, expectedRevision });

          await new PlatformAuditService(tx).append({
            action: 'admin.authSettings.update',
            actorUserId: ctx.userId!,
            afterDiff: {
              emailDomainAllowlistEnabled: next.emailDomainAllowlistEnabled,
              emailDomainCount: next.emailDomainAllowlist.length,
              openRegistration: next.openRegistration,
              revision: next.revision,
            },
            configRevision: next.revision,
            result: 'success',
            targetId: 'global',
            targetType: 'authSettings',
          });

          return next;
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        if (error instanceof PlatformRevisionConflictError) {
          return throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
            details: error.details as Record<string, string | number | boolean | null> | undefined,
          });
        }
        if (
          error instanceof Error &&
          (error.message === 'PLATFORM_AUTH_SETTINGS_ALLOWLIST_EMPTY' ||
            error.message.includes('allowlist_nonempty_when_enabled'))
        ) {
          return throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
            details: { issueCount: 1, reason: 'allowlist_empty_when_enabled' },
            httpCode: 'BAD_REQUEST',
          });
        }
        if (error instanceof z.ZodError) {
          return throwEnterpriseError({
            code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
            details: { issueCount: error.issues.length },
          });
        }
        // Permission / input errors from middleware already escaped; surface audit/write failure stably.
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          details: { issueCount: 1, reason: 'audit_or_write_failed' },
          httpCode: 'INTERNAL_SERVER_ERROR',
        });
      }
    }),
});
