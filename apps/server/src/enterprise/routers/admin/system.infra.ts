import type { AdminSystemUpdateInfraSettingsInput } from '../../contracts/adminSystem';
import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import { AUDIT_ACTION } from '../../services/audit/auditActionCatalog';
import {
  getMailSettings,
  getObjectStorageSettings,
  INFRA_SETTINGS_AUDIT_TARGET_TYPE,
  mailSecretChanged,
  objectStorageSecretChanged,
  publishInfraInvalidation,
  summarizeMailAfterDiff,
  summarizeObjectStorageAfterDiff,
  updateMailSettings,
  updateObjectStorageSettings,
} from '../../services/infraSettings';
import { PlatformAuditService } from '../../services/platformAudit';
import { executePlatformSystem } from './system.errors';
import type { SystemHandlerCtx } from './system.reauth';

export const updateInfraSettings = async ({
  ctx,
  input,
}: {
  ctx: SystemHandlerCtx;
  input: AdminSystemUpdateInfraSettingsInput;
}) => {
  const targetId = input.dependency === 'objectStorage' ? 'object_storage' : 'mail';
  const action =
    input.dependency === 'objectStorage'
      ? AUDIT_ACTION.SYSTEM_INFRA_OBJECT_STORAGE_UPDATE
      : AUDIT_ACTION.SYSTEM_INFRA_MAIL_UPDATE;
  await assertDangerousReauthWithAudit({
    authenticatedAt: ctx.authenticatedAt,
    authMethod: ctx.authMethod,
    serverDB: ctx.serverDB,
    denied: {
      action,
      actorUserId: ctx.userId!,
      reason: input.reason,
      targetId,
      targetType: INFRA_SETTINGS_AUDIT_TARGET_TYPE,
    },
  });

  return executePlatformSystem(async () => {
    const applied = await ctx.serverDB.transaction(async (tx) => {
      if (input.dependency === 'objectStorage') {
        const previous = await getObjectStorageSettings(tx);
        const row = await updateObjectStorageSettings(tx, {
          config: input.config,
          expectedRevision: input.expectedRevision,
          updatedBy: ctx.userId!,
        });
        await new PlatformAuditService(tx).append({
          action: AUDIT_ACTION.SYSTEM_INFRA_OBJECT_STORAGE_UPDATE,
          actorUserId: ctx.userId!,
          afterDiff: summarizeObjectStorageAfterDiff(
            row.config,
            objectStorageSecretChanged(previous.config, row.config),
          ),
          configRevision: row.revision,
          reason: input.reason,
          result: 'success',
          targetId,
          targetType: INFRA_SETTINGS_AUDIT_TARGET_TYPE,
        });
        return {
          revision: row.revision,
          source: row.config.enabled ? ('db' as const) : ('env' as const),
        };
      }

      const previous = await getMailSettings(tx);
      const row = await updateMailSettings(tx, {
        config: input.config,
        expectedRevision: input.expectedRevision,
        updatedBy: ctx.userId!,
      });
      await new PlatformAuditService(tx).append({
        action: AUDIT_ACTION.SYSTEM_INFRA_MAIL_UPDATE,
        actorUserId: ctx.userId!,
        afterDiff: summarizeMailAfterDiff(
          row.config,
          mailSecretChanged(previous.config, row.config),
        ),
        configRevision: row.revision,
        reason: input.reason,
        result: 'success',
        targetId,
        targetType: INFRA_SETTINGS_AUDIT_TARGET_TYPE,
      });
      return {
        revision: row.revision,
        source: row.config.enabled ? ('db' as const) : ('env' as const),
      };
    });

    await publishInfraInvalidation(applied.revision);
    return { appliedAt: new Date(), revision: applied.revision, source: applied.source };
  });
};
