import { rebuildSandboxProviderFromSettings } from '@/server/services/sandbox/factory';

import type {
  AdminSystemUpdateDocumentRenderSettingsInput,
  AdminSystemUpdateSandboxSettingsInput,
} from '../../contracts/adminSystem';
import {
  DOCUMENT_RENDER_SETTINGS_AUDIT_ACTION,
  DOCUMENT_RENDER_SETTINGS_AUDIT_TARGET_TYPE,
  invalidateEffectiveDocumentRenderSettings,
  summarizeDocumentRenderAfterDiff,
  updateDocumentRenderSettings,
} from '../../services/documentRenderSettings';
import { PlatformAuditService } from '../../services/platformAudit';
import { invalidateInfraHealthMemo } from '../../services/platformSystem/infraHealthMemo';
import {
  SANDBOX_SETTINGS_AUDIT_ACTION,
  SANDBOX_SETTINGS_AUDIT_TARGET_TYPE,
  summarizeSandboxAfterDiff,
  toSandboxSettingsOutput,
  updateSandboxSettings,
} from '../../services/sandboxSettings';
import { executePlatformSystem } from './system.errors';
import type { SystemHandlerCtx } from './system.reauth';

export const updateDocumentRenderSettingsHandler = async ({
  ctx,
  input,
}: {
  ctx: SystemHandlerCtx;
  input: AdminSystemUpdateDocumentRenderSettingsInput;
}) =>
  executePlatformSystem(async () => {
    const view = await ctx.serverDB.transaction(async (tx) => {
      const row = await updateDocumentRenderSettings(tx, {
        actorId: ctx.userId!,
        config: input.config,
        expectedRevision: input.expectedRevision,
        reason: input.reason,
      });
      await new PlatformAuditService(tx).append({
        action: DOCUMENT_RENDER_SETTINGS_AUDIT_ACTION,
        actorUserId: ctx.userId!,
        afterDiff: summarizeDocumentRenderAfterDiff(input.config),
        configRevision: row.revision,
        reason: input.reason,
        result: 'success',
        targetId: 'documentRender',
        targetType: DOCUMENT_RENDER_SETTINGS_AUDIT_TARGET_TYPE,
      });
      return row;
    });
    invalidateEffectiveDocumentRenderSettings();
    invalidateInfraHealthMemo();
    return view;
  });

export const updateSandboxSettingsHandler = async ({
  ctx,
  input,
}: {
  ctx: SystemHandlerCtx;
  input: AdminSystemUpdateSandboxSettingsInput;
}) =>
  executePlatformSystem(async () => {
    const view = await ctx.serverDB.transaction(async (tx) => {
      const row = await updateSandboxSettings(tx, {
        config: input.config,
        expectedRevision: input.expectedRevision,
        updatedBy: ctx.userId!,
      });
      await new PlatformAuditService(tx).append({
        action: SANDBOX_SETTINGS_AUDIT_ACTION,
        actorUserId: ctx.userId!,
        afterDiff: summarizeSandboxAfterDiff(input.config),
        configRevision: row.revision,
        reason: input.reason,
        result: 'success',
        targetId: 'sandbox',
        targetType: SANDBOX_SETTINGS_AUDIT_TARGET_TYPE,
      });
      return row;
    });
    invalidateInfraHealthMemo();
    await rebuildSandboxProviderFromSettings();
    return toSandboxSettingsOutput(view);
  });
