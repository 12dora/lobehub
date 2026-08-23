import type { z } from 'zod';

import {
  PlatformAiCatalogModel,
  type PlatformAiProviderDraftView,
  PlatformCatalogAuthorityModel,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import {
  type PlatformAiProviderConfig,
  type PlatformAiProviderSettings,
} from '@/database/schemas/platform';

import {
  type adminAiProviderCreateDraftInputSchema,
  type adminAiProviderDeleteInputSchema,
  type adminAiProviderUpdateDraftInputSchema,
  type AiProviderDraft,
  aiProviderDraftSchema,
} from '../../contracts/aiCatalog';
import { PlatformAuditService } from '../platformAudit';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { invalidateAiCatalogAuthorityToken } from '../platformInstance/catalogTokens';
import { AiCatalogAdminServiceSyncOps } from './adminService.sync';
import {
  validateAiCatalogCredentialShape,
  validateAiCatalogRuntimeProvider,
} from './credentialAdapter';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { resolveAiCatalogDependentsForModels } from './dependencies';
import { AiCatalogNotFoundError, AiCatalogResourceInUseError } from './errors';
import { aiCatalogDraftToken } from './shared';

type CreateProviderInput = z.infer<typeof adminAiProviderCreateDraftInputSchema>;
type UpdateProviderInput = z.infer<typeof adminAiProviderUpdateDraftInputSchema>;
type DeleteProviderInput = z.infer<typeof adminAiProviderDeleteInputSchema>;

/**
 * Project internal draft view → client-facing DTO.
 * Secret fingerprint stays server-internal (draft tokens / connectivity); the strict
 * `aiSecretStateSchema` intentionally omits it so it must never appear in list/detail outputs.
 */
export const toProviderDraft = (view: PlatformAiProviderDraftView): AiProviderDraft =>
  aiProviderDraftSchema.parse({
    ...view,
    secret: {
      configured: view.secret.configured,
      updatedAt: view.secret.updatedAt,
    },
  });

export abstract class AiCatalogAdminServiceDraftOps extends AiCatalogAdminServiceSyncOps {
  createProviderDraft = async (
    actorUserId: string,
    input: CreateProviderInput,
  ): Promise<AiProviderDraft> => {
    const { reason: rawReason, secret, ...values } = input;
    const reason = await this.sanitizeReason(rawReason, undefined, secret);
    try {
      const settings = (values.settings ?? {}) as PlatformAiProviderSettings;
      const runtimeProvider = validateAiCatalogRuntimeProvider(
        values.providerKey,
        settings,
        values.source,
      );
      if (secret?.operation === 'replace' || secret?.operation === 'merge') {
        validateAiCatalogCredentialShape(
          runtimeProvider,
          typeof secret.value === 'string' ? { apiKey: secret.value } : secret.value,
        );
      }
      const keyVaults = await this.secrets.resolveMutationKeyVaults(null, secret);
      assertAiCatalogPublicFieldsExcludeCredentials(values, keyVaults);
      const appliedSecret = await this.secrets.applyMutation(null, secret);
      return await this.db.transaction(async (tx) => {
        const repository = new PlatformAiCatalogRepository(tx);
        const row = await repository.createProvider({
          ...values,
          ...appliedSecret,
          config: values.config as PlatformAiProviderConfig | undefined,
          createdBy: actorUserId,
          settings,
          status: 'draft',
          updatedBy: actorUserId,
        });
        if (
          appliedSecret.encryptedKeyVaults &&
          appliedSecret.secretFingerprint &&
          appliedSecret.secretKeyId
        ) {
          await repository.storeProviderSecretVersion({
            ciphertext: appliedSecret.encryptedKeyVaults,
            fingerprint: appliedSecret.secretFingerprint,
            keyId: appliedSecret.secretKeyId,
            keyVersion: appliedSecret.secretKeyVersion ?? 1,
            providerId: row.id,
          });
        }
        await new PlatformAuditService(tx).append({
          action: 'admin.aiProviders.createDraft',
          actorUserId,
          afterDiff: { providerId: row.id, providerKey: row.providerKey },
          reason,
          result: 'success',
          targetId: row.id,
          targetType: 'provider',
        });
        const draft = await new PlatformAiCatalogModel(tx).getProvider(row.id);
        if (!draft) throw new AiCatalogNotFoundError();
        return toProviderDraft(draft);
      });
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiProviders.createDraft',
        actorUserId,
        reason,
      });
      throw error;
    }
  };

  updateProviderDraft = async (
    actorUserId: string,
    input: UpdateProviderInput,
  ): Promise<AiProviderDraft> => {
    const {
      expectedDraftToken,
      expectedRevision,
      id,
      reason: rawReason,
      secret,
      ...values
    } = input;
    const reason = await this.sanitizeReason(rawReason, id, secret);
    try {
      return await this.db.transaction(async (tx) => {
        const before = await this.getLockedDraft(tx, id, expectedDraftToken, expectedRevision);
        const repository = new PlatformAiCatalogRepository(tx);
        const current = await repository.getProvider(id);
        if (!current) throw new AiCatalogNotFoundError();
        const settings = (values.settings ?? before.settings) as PlatformAiProviderSettings;
        const runtimeProvider = validateAiCatalogRuntimeProvider(
          before.providerKey,
          settings,
          before.source,
        );
        if (secret?.operation === 'replace' || secret?.operation === 'merge') {
          validateAiCatalogCredentialShape(
            runtimeProvider,
            typeof secret.value === 'string' ? { apiKey: secret.value } : secret.value,
          );
        }
        const keyVaults = await this.secrets.resolveMutationKeyVaults(current, secret);
        assertAiCatalogPublicFieldsExcludeCredentials(
          { ...before, ...values, models: before.models },
          keyVaults,
        );
        const appliedSecret = await this.secrets.applyMutation(current, secret);
        await repository.updateProvider(id, {
          ...values,
          ...appliedSecret,
          config: values.config as PlatformAiProviderConfig | undefined,
          settings,
          status: 'draft',
          updatedBy: actorUserId,
        });
        if (
          appliedSecret.encryptedKeyVaults &&
          appliedSecret.secretFingerprint &&
          appliedSecret.secretKeyId
        ) {
          await repository.storeProviderSecretVersion({
            ciphertext: appliedSecret.encryptedKeyVaults,
            fingerprint: appliedSecret.secretFingerprint,
            keyId: appliedSecret.secretKeyId,
            keyVersion: appliedSecret.secretKeyVersion ?? 1,
            providerId: id,
          });
        }
        const after = await new PlatformAiCatalogModel(tx).getProvider(id);
        if (!after) throw new AiCatalogNotFoundError();
        await new PlatformAuditService(tx).append({
          action: 'admin.aiProviders.updateDraft',
          actorUserId,
          afterDiff: { draft: after },
          beforeDiff: { draft: before },
          configRevision: after.revision,
          reason,
          result: 'success',
          targetId: id,
          targetType: 'provider',
        });
        return toProviderDraft(after);
      });
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiProviders.updateDraft',
        actorUserId,
        reason,
        targetId: id,
      });
      throw error;
    }
  };

  deleteProvider = async (actorUserId: string, input: DeleteProviderInput) => {
    const { expectedDraftToken, expectedRevision, id, reason: rawReason } = input;
    const reason = await this.sanitizeReason(rawReason, id);
    try {
      await this.db.transaction(async (tx) => {
        const repository = new PlatformAiCatalogRepository(tx);
        // 1) Provider row lock first — same order as publication.lockAndGetRevision.
        const provider = await repository.lockProvider(id);
        if (!provider) throw new AiCatalogNotFoundError();
        // 2) Then the dependency-publication advisory lock (publication acquires it in
        //    assertLockedState after the provider row is already held).
        await acquirePlatformDependencyPublicationLock(tx);
        if (provider.revision !== expectedRevision) {
          throw new PlatformRevisionConflictError('Provider changed before delete', {
            currentRevision: provider.revision,
            expectedRevision,
            resourceId: id,
            resourceType: 'provider',
          });
        }
        const draft = await new PlatformAiCatalogModel(tx).getProvider(id);
        if (!draft) throw new AiCatalogNotFoundError();
        if (aiCatalogDraftToken(draft) !== expectedDraftToken) {
          throw new PlatformRevisionConflictError('Provider draft token changed before delete', {
            resourceId: id,
            resourceType: 'provider',
          });
        }
        // Refuse when any owned model is still referenced by a published agent / setting.
        // Force-delete is intentionally not implemented (parallel gap to force-disable).
        const models = await repository.listModels(id);
        const dependents = await resolveAiCatalogDependentsForModels(
          tx,
          provider.providerKey,
          models.map((model) => model.modelKey),
        );
        if (dependents.some((item) => item.blocking)) {
          throw new AiCatalogResourceInUseError(dependents);
        }
        // True hard delete: models, revision history and the provider row (its secret
        // versions cascade). Afterwards the instance looks as if this provider had never
        // been platform-managed, so runtime resolves NOT_FOUND and hands the provider back
        // to the user's own BYOK configuration.
        await repository.deleteProviderModels(id);
        const revisionsPurged = await repository.deleteProviderRevisions(id);
        await repository.deleteProvider(id);
        // Advance the multi-instance catalog authority in the same transaction as the delete,
        // exactly like a publish, so every instance drops the provider on its next peek.
        await new PlatformCatalogAuthorityModel(tx).bumpGeneration('ai_catalog');
        await new PlatformAuditService(tx).append({
          action: 'admin.aiProviders.delete',
          actorUserId,
          beforeDiff: {
            modelCount: models.length,
            providerId: id,
            providerKey: provider.providerKey,
            revision: provider.revision,
            revisionsPurged,
          },
          reason,
          result: 'success',
          targetId: id,
          targetType: 'provider',
        });
      });
      invalidateAiCatalogAuthorityToken();
      return { deleted: true as const };
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.aiProviders.delete',
        actorUserId,
        reason,
        targetId: id,
      });
      throw error;
    }
  };
}
