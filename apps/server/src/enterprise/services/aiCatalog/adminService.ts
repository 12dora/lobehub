import { randomUUID } from 'node:crypto';

import type { z } from 'zod';

import {
  PlatformAiCatalogModel,
  type PlatformAiProviderDraftView,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import {
  type PlatformAiProviderConfig,
  type PlatformAiProviderSettings,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  type adminAiProviderCreateDraftInputSchema,
  type adminAiProviderDeleteInputSchema,
  type adminAiProviderUpdateDraftInputSchema,
  type AiProviderDraft,
  aiProviderDraftSchema,
} from '../../contracts/aiCatalog';
import type { PlatformSecretService } from '../../security/secret';
import { PlatformAuditService } from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { AiCatalogAdminServiceModelOps } from './adminService.models';
import { AiCatalogReadService } from './catalogReadService';
import {
  AiCatalogConnectionTestService,
  type AiConnectionProbe,
  type AiConnectionTestResult,
} from './connectionTestService';
import {
  normalizeAiCatalogExecutionCredentials,
  validateAiCatalogCredentialShape,
  validateAiCatalogRuntimeProvider,
} from './credentialAdapter';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { resolveAiCatalogDependentsForModels } from './dependencies';
import {
  AiCatalogNotFoundError,
  AiCatalogResourceInUseError,
  AiCatalogValidationError,
} from './errors';
import { sanitizeAiCatalogPersistedText } from './persistentText';
import { AiCatalogPublicationService } from './publication';
import { AiCatalogSecretManager, type AiSecretMutation } from './secretManager';
import {
  aiCatalogDraftToken,
  appendAiCatalogFailureAudit,
  getLockedAiCatalogDraft,
  publishedPayloadConnectivityMatchesDraft,
} from './shared';

type CreateProviderInput = z.infer<typeof adminAiProviderCreateDraftInputSchema>;
type UpdateProviderInput = z.infer<typeof adminAiProviderUpdateDraftInputSchema>;
type DeleteProviderInput = z.infer<typeof adminAiProviderDeleteInputSchema>;

export interface AiCatalogAdminServiceOptions {
  connectionProbe?: AiConnectionProbe;
  invalidation?: PlatformConfigInvalidationPublisher;
  lifecycle?: {
    afterDraftLock?: () => Promise<void>;
    afterArchiveDependencyCheck?: () => Promise<void>;
    afterModelDependencyCheck?: () => Promise<void>;
    afterPublishLock?: (tx: Transaction) => Promise<void>;
  };
}

/**
 * Project internal draft view → client-facing DTO.
 * Secret fingerprint stays server-internal (draft tokens / connectivity); the strict
 * `aiSecretStateSchema` intentionally omits it so it must never appear in list/detail outputs.
 */
const toProviderDraft = (view: PlatformAiProviderDraftView): AiProviderDraft =>
  aiProviderDraftSchema.parse({
    ...view,
    secret: {
      configured: view.secret.configured,
      updatedAt: view.secret.updatedAt,
    },
  });

export class AiCatalogAdminService extends AiCatalogAdminServiceModelOps {
  protected readonly connectionTests: AiCatalogConnectionTestService;
  protected readonly db: LobeChatDatabase;
  protected readonly lifecycle: NonNullable<AiCatalogAdminServiceOptions['lifecycle']>;
  protected readonly publication: AiCatalogPublicationService;
  protected readonly secrets: AiCatalogSecretManager;

  constructor(
    db: LobeChatDatabase,
    secretService: PlatformSecretService,
    options: AiCatalogAdminServiceOptions = {},
  ) {
    super();
    this.db = db;
    this.connectionTests = new AiCatalogConnectionTestService(options.connectionProbe);
    this.lifecycle = options.lifecycle ?? {};
    this.secrets = new AiCatalogSecretManager(secretService);
    this.publication = new AiCatalogPublicationService(db, this.secrets, {
      invalidation: options.invalidation,
      lifecycle: options.lifecycle,
    });
  }

  protected sanitizeReason = async (
    reason: string,
    providerId?: string,
    secretMutation?: AiSecretMutation,
  ): Promise<string> => {
    const credentialValues: unknown[] = [];
    if (secretMutation?.operation === 'replace' || secretMutation?.operation === 'merge') {
      credentialValues.push(secretMutation.value);
    }
    if (providerId) {
      const provider = await new PlatformAiCatalogRepository(this.db).getProvider(providerId);
      if (provider?.encryptedKeyVaults) {
        try {
          credentialValues.push(await this.secrets.decrypt(provider.encryptedKeyVaults));
        } catch {
          // Persisted text still receives generic shape redaction below.
        }
      }
    }
    return sanitizeAiCatalogPersistedText(reason, credentialValues);
  };

  protected getLockedDraft = (
    tx: Parameters<typeof getLockedAiCatalogDraft>[0]['tx'],
    providerId: string,
    expectedDraftToken: string,
    expectedRevision?: number,
  ) =>
    getLockedAiCatalogDraft({
      afterLock: this.lifecycle.afterDraftLock,
      expectedDraftToken,
      expectedRevision,
      providerId,
      tx,
    });

  protected appendFailureAudit = (params: {
    action: string;
    actorUserId: string;
    reason: string;
    targetId?: string;
  }) => appendAiCatalogFailureAudit(this.db, params);

  /**
   * Load provider detail by platform UUID, or by user-facing providerKey.
   * String argument is treated as platform UUID (legacy call sites).
   */
  getDetail = async (providerIdOrLookup: string | { id?: string; providerKey?: string }) => {
    const model = new PlatformAiCatalogModel(this.db);
    let draft: PlatformAiProviderDraftView | undefined;
    if (typeof providerIdOrLookup === 'string') {
      draft = await model.getProvider(providerIdOrLookup);
    } else if (providerIdOrLookup.id) {
      draft = await model.getProvider(providerIdOrLookup.id);
    } else if (providerIdOrLookup.providerKey) {
      draft = await model.getProviderByKey(providerIdOrLookup.providerKey);
    }
    if (!draft) throw new AiCatalogNotFoundError();
    const publishedCatalog = await new AiCatalogReadService(this.db).getPublished();
    const published =
      publishedCatalog.providers.find((provider) => provider.providerKey === draft.providerKey) ??
      null;
    return {
      baseRevision: draft.revision,
      draft: toProviderDraft(draft),
      draftToken: aiCatalogDraftToken(draft),
      published,
    };
  };

  /**
   * Bounded bulk detail for runtime-state assembly.
   * True batch path: 1 providers query + 1 models query + 1 published snapshot
   * (does not hide N+1 behind Promise.all of getDetail).
   * Missing ids/keys are reported in failed* arrays rather than aborting.
   */
  getDetailsBatch = async (input: { ids?: string[]; providerKeys?: string[] }) => {
    const ids = input.ids ?? [];
    const providerKeys = input.providerKeys ?? [];
    const model = new PlatformAiCatalogModel(this.db);
    const drafts = await model.getProvidersBatch(ids.length > 0 ? { ids } : { providerKeys });
    const publishedCatalog = await new AiCatalogReadService(this.db).getPublished();
    const publishedByKey = new Map(
      publishedCatalog.providers.map((provider) => [provider.providerKey, provider] as const),
    );

    const items = drafts.map((draft) => ({
      baseRevision: draft.revision,
      draft: toProviderDraft(draft),
      draftToken: aiCatalogDraftToken(draft),
      published: publishedByKey.get(draft.providerKey) ?? null,
    }));

    if (ids.length > 0) {
      const found = new Set(drafts.map((draft) => draft.id));
      return {
        failedIds: ids.filter((id) => !found.has(id)),
        failedProviderKeys: [] as string[],
        items,
      };
    }

    const foundKeys = new Set(drafts.map((draft) => draft.providerKey));
    return {
      failedIds: [] as string[],
      failedProviderKeys: providerKeys.filter((key) => !foundKeys.has(key)),
      items,
    };
  };

  listRevisionHistory = async (params: { beforeRevision?: number; id: string; limit?: number }) => {
    const repository = new PlatformAiCatalogRepository(this.db);
    if (!(await repository.getProvider(params.id))) throw new AiCatalogNotFoundError();
    return repository.listProviderRevisionMetadata({
      beforeRevision: params.beforeRevision,
      limit: params.limit,
      providerId: params.id,
    });
  };

  getModelDraftContext = async (providerId: string) => {
    const draft = await new PlatformAiCatalogModel(this.db).getProvider(providerId);
    if (!draft) throw new AiCatalogNotFoundError();
    return {
      baseRevision: draft.revision,
      draftToken: aiCatalogDraftToken(draft),
      modelIds: draft.models.map((model) => model.id),
      providerId,
    };
  };

  listModelCreateTargets = async (params: { cursor?: string; limit?: number; query?: string }) => {
    const page = await new PlatformAiCatalogModel(this.db).listProviders(params);
    return {
      items: page.items.map(({ displayName, id, providerKey }) => ({
        displayName,
        id,
        providerKey,
      })),
      nextCursor: page.nextCursor,
    };
  };

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
        // Ever-published providers (revision > 0) must keep a fail-closed tombstone so runtime
        // can distinguish deliberate removal from "never managed" and refuse BYOK fallback.
        // Admins must archive/disable instead of hard-deleting published providers.
        if (provider.revision > 0) {
          throw new AiCatalogValidationError([
            'Published providers cannot be hard-deleted; archive or disable them instead',
          ]);
        }
        // Refuse when any owned model is still referenced by a published agent / setting.
        const models = await repository.listModels(id);
        const dependents = await resolveAiCatalogDependentsForModels(
          tx,
          provider.providerKey,
          models.map((model) => model.modelKey),
        );
        if (dependents.some((item) => item.blocking)) {
          throw new AiCatalogResourceInUseError(dependents);
        }
        await repository.deleteProviderModels(id);
        await repository.deleteProviderRevisions(id);
        await repository.deleteProvider(id);
        await new PlatformAuditService(tx).append({
          action: 'admin.aiProviders.delete',
          actorUserId,
          beforeDiff: {
            modelCount: models.length,
            providerId: id,
            providerKey: provider.providerKey,
          },
          reason,
          result: 'success',
          targetId: id,
          targetType: 'provider',
        });
      });
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

  testProvider = async (
    actorUserId: string,
    input: { id: string; reason: string },
  ): Promise<AiConnectionTestResult> => {
    const reason = await this.sanitizeReason(input.reason, input.id);
    let finalized:
      { applied: true; result: AiConnectionTestResult } | { applied: false } | undefined;
    try {
      const snapshot = await this.db.transaction(async (tx) => {
        const repository = new PlatformAiCatalogRepository(tx);
        const provider = await repository.lockProvider(input.id);
        if (!provider) throw new AiCatalogNotFoundError();
        const draft = await new PlatformAiCatalogModel(tx).getProvider(input.id);
        if (!draft) throw new AiCatalogNotFoundError();
        const attemptId = randomUUID();
        const testedAt = new Date();
        const testedDraftToken = aiCatalogDraftToken(draft);
        await repository.updateProvider(input.id, {
          connectionTestAttemptId: attemptId,
          connectionTestErrorCategory: null,
          connectionTestLatencyMs: null,
          connectionTestSanitizedMessage: 'Connection test in progress',
          connectionTestStatus: 'pending',
          connectionTestedAt: testedAt,
          connectionTestedDraftToken: testedDraftToken,
          connectionTestedRevision: draft.revision,
        });
        const checkModel = draft.models.find(
          (model) => model.enabled && model.modelKey === provider.checkModel,
        );
        return { attemptId, checkModelExecutable: checkModel?.type === 'chat', provider };
      });
      let result: AiConnectionTestResult;
      if (!snapshot.checkModelExecutable) {
        result = {
          errorCategory: 'invalid_config',
          latencyMs: 0,
          sanitizedMessage: 'Connection failed: invalid provider configuration',
          status: 'failure',
          testedAt: new Date(),
        };
      } else
        try {
          const keyVaults = snapshot.provider.encryptedKeyVaults
            ? await this.secrets.decrypt(snapshot.provider.encryptedKeyVaults)
            : {};
          const normalized = normalizeAiCatalogExecutionCredentials({
            config: snapshot.provider.config,
            keyVaults,
            providerKey: snapshot.provider.providerKey,
            source: snapshot.provider.source,
            settings: snapshot.provider.settings,
          });
          result = await this.connectionTests.test({
            keyVaults: normalized.keyVaults,
            provider: snapshot.provider,
            runtimeProvider: normalized.runtimeProvider,
          });
        } catch {
          result = {
            errorCategory: 'invalid_config',
            latencyMs: 0,
            sanitizedMessage: 'Connection failed: invalid provider configuration',
            status: 'failure',
            testedAt: new Date(),
          };
        }
      // CAS finalization + success/failure audit must be one transaction so a discarded
      // (superseded) probe never audits or returns as authoritative.
      finalized = await this.db.transaction(async (tx) => {
        const applied = await new PlatformAiCatalogRepository(tx).completeProviderConnectionTest(
          input.id,
          snapshot.attemptId,
          {
            connectionTestErrorCategory: result.errorCategory,
            connectionTestLatencyMs: result.latencyMs,
            connectionTestSanitizedMessage: result.sanitizedMessage,
            connectionTestStatus: result.status,
            connectionTestedAt: result.testedAt,
          },
        );
        if (!applied) return { applied: false as const };
        await new PlatformAuditService(tx).append({
          action: 'admin.aiProviders.test',
          actorUserId,
          afterDiff: {
            errorCategory: result.errorCategory,
            latencyMs: result.latencyMs,
            status: result.status,
          },
          reason,
          result: result.status === 'success' ? 'success' : 'failure',
          targetId: input.id,
          targetType: 'provider',
        });
        return { applied: true as const, result };
      });
    } catch (error) {
      // Real operational failures only. Superseded CAS no-ops are handled below and must
      // not write a misleading FAILURE audit for a discarded probe.
      await this.appendFailureAudit({
        action: 'admin.aiProviders.test',
        actorUserId,
        reason,
        targetId: input.id,
      });
      throw error;
    }

    if (finalized?.applied) return finalized.result;

    // Superseded attempt (CAS no-op): return the authoritative persisted state without auditing.
    const detail = await new PlatformAiCatalogModel(this.db).getProvider(input.id);
    if (!detail) throw new AiCatalogNotFoundError();
    const current = detail.connectionTest;
    if (current && (current.status === 'success' || current.status === 'failure')) {
      return {
        errorCategory: current.errorCategory,
        latencyMs: current.latencyMs ?? 0,
        sanitizedMessage: current.sanitizedMessage,
        status: current.status,
        testedAt: current.testedAt,
      };
    }
    // Newer attempt still pending — surface as non-audited validation (not a probe failure).
    throw new AiCatalogValidationError(['Connection test superseded by a newer attempt']);
  };

  publishProvider: AiCatalogPublicationService['publishProvider'] = (actorUserId, input) =>
    this.publication.publishProvider(actorUserId, input);

  archiveProvider: AiCatalogPublicationService['archiveProvider'] = (actorUserId, input) =>
    this.publication.archiveProvider(actorUserId, input);

  rollbackProvider: AiCatalogPublicationService['rollbackProvider'] = (actorUserId, input) =>
    this.publication.rollbackProvider(actorUserId, input);

  /**
   * Determine whether connectivity-sensitive fields differ from the last published revision.
   * Used to decide whether applyImmediate may skip a retest (cosmetic-only) or must probe.
   */
  private connectivityChangedFromPublished = async (providerId: string): Promise<boolean> => {
    const draft = await new PlatformAiCatalogModel(this.db).getProvider(providerId);
    if (!draft) throw new AiCatalogNotFoundError();
    if (draft.revision === 0) return true;
    const repository = new PlatformAiCatalogRepository(this.db);
    const published = await repository.getProviderRevision(providerId, draft.revision);
    if (!published || published.status !== 'published') return true;
    return !publishedPayloadConnectivityMatchesDraft(draft, {
      payload: published.payload as Record<string, unknown>,
      secretFingerprint: published.secretFingerprint,
    });
  };

  /**
   * Auto-run connectivity test when required so applyImmediate can land without a separate UI step.
   * - revision 0 (first publish): always retest when credentials + ≥1 enabled model are present.
   * - revision > 0: retest only when connectivity-sensitive fields changed vs last publish;
   *   cosmetic-only edits reuse the stale-test allow path in validatePublishDraft.
   */
  /**
   * Stable machine-readable codes returned as `publishError` for client i18n.
   * Free-form prose is never surfaced — map codes under `aiSettings.draftBanner.error.*`.
   */
  private preparePublishConnectionTest = async (
    actorUserId: string,
    providerId: string,
    reason: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const detail = await this.getDetail(providerId);
    const connectivityChanged =
      detail.baseRevision === 0 || (await this.connectivityChangedFromPublished(providerId));
    if (!connectivityChanged) return { ok: true };

    // Fresh connection test already bound to this draft — no need to re-probe.
    if (detail.draft.connectionTest?.status === 'success' && !detail.draft.connectionTest.stale) {
      return { ok: true };
    }

    const hasEnabledModel = detail.draft.models.some((m) => m.enabled);
    const hasCredentials = detail.draft.secret.configured;
    if (!hasEnabledModel || !hasCredentials) {
      return {
        ok: false,
        // Stable codes — client translates; do not return localized/server prose.
        reason: !hasEnabledModel ? 'model_required' : 'secret_required',
      };
    }
    const test = await this.testProvider(actorUserId, { id: providerId, reason });
    if (test.status !== 'success') {
      return {
        ok: false,
        reason: 'connection_test_failed',
      };
    }
    return { ok: true };
  };

  protected tryPublishImmediate = async (
    actorUserId: string,
    providerId: string,
    reason: string,
    options?: { softFail?: boolean },
  ) => {
    const prep = await this.preparePublishConnectionTest(actorUserId, providerId, reason);
    if (!prep.ok) {
      const detail = await this.getDetail(providerId);
      return {
        auditId: null as string | null,
        draft: detail.draft,
        published: false,
        publishError: prep.reason,
        revision: detail.baseRevision,
      };
    }
    const detail = await this.getDetail(providerId);

    try {
      const published = await this.publishProvider(actorUserId, {
        // Cosmetic-only republish may reuse a stale successful test; connectivity changes
        // were already re-probed above (or rejected). Validation still re-checks field sensitivity.
        allowStaleConnectionTest: detail.baseRevision > 0,
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: providerId,
        reason,
      });
      const after = await this.getDetail(providerId);
      return {
        auditId: published.auditId as string | null,
        draft: after.draft,
        published: true,
        publishError: null as string | null,
        revision: published.revision,
      };
    } catch (error) {
      if (options?.softFail || error instanceof AiCatalogValidationError) {
        const after = await this.getDetail(providerId);
        // Stable machine-readable codes only — never free-form Error.message / issue prose.
        const reasonCode =
          error instanceof AiCatalogValidationError ? 'validation_failed' : 'publish_failed';
        if (options?.softFail || after.baseRevision === 0) {
          return {
            auditId: null as string | null,
            draft: after.draft,
            published: false,
            publishError: reasonCode,
            revision: after.baseRevision,
          };
        }
      }
      throw error;
    }
  };

  /**
   * Apply a provider draft mutation then publish immediately.
   * Sequential (draft then publish); publish failure leaves a visible draft (no silent half-state).
   */
  applyProviderImmediate = async (
    actorUserId: string,
    input: (CreateProviderInput & { mode: 'create' }) | (UpdateProviderInput & { mode: 'update' }),
  ) => {
    let providerId: string;
    if (input.mode === 'create') {
      const { mode: _mode, ...createInput } = input;
      const draft = await this.createProviderDraft(actorUserId, createInput);
      providerId = draft.id;
    } else {
      const { mode: _mode, ...updateInput } = input;
      await this.updateProviderDraft(actorUserId, updateInput);
      providerId = input.id;
    }

    // Create always soft-fails publish validation; updates soft-fail only on first-publish path
    // (revision 0). Already-published update failures still throw for UI visibility (M1).
    const softFail = input.mode === 'create';
    const result = await this.tryPublishImmediate(actorUserId, providerId, input.reason, {
      softFail,
    });
    // For update on revision>0 that fails validation, rethrow so adapter/toast surfaces it.
    if (!result.published && input.mode === 'update') {
      const after = await this.getDetail(providerId);
      if (after.baseRevision > 0 && result.publishError) {
        throw new AiCatalogValidationError([result.publishError]);
      }
    }
    return {
      auditId: result.auditId,
      draft: result.draft,
      published: result.published,
      publishError: result.publishError,
      revision: result.revision,
    };
  };

  /**
   * Retry publish for banner (re-run connection test when revision === 0, then publish).
   */
  publishNow = async (actorUserId: string, input: { id: string; reason: string }) => {
    return this.tryPublishImmediate(actorUserId, input.id, input.reason, { softFail: true });
  };
}

export {
  type AiCatalogDependent,
  AiCatalogNotFoundError,
  AiCatalogProviderDisabledError,
  AiCatalogResourceInUseError,
  AiCatalogValidationError,
} from './errors';
