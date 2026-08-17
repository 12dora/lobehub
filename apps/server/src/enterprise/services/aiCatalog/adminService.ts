import { randomUUID } from 'node:crypto';

import type { z } from 'zod';

import {
  PlatformAiCatalogModel,
  type PlatformAiModelDraftView,
  type PlatformAiProviderDraftView,
  PlatformCatalogAuthorityModel,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import {
  type PlatformAiProviderConfig,
  type PlatformAiProviderItem,
  type PlatformAiProviderSettings,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import { resolvePlatformBrowserProfile } from '@/server/modules/ModelRuntime';

import {
  type adminAiProviderCreateDraftInputSchema,
  type adminAiProviderDeleteInputSchema,
  type adminAiProviderUpdateDraftInputSchema,
  type AiProviderDraft,
  aiProviderDraftSchema,
} from '../../contracts/aiCatalog';
import type { PlatformSecretService } from '../../security/secret';
import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { invalidateAiCatalogAuthorityToken } from '../platformInstance/catalogTokens';
import type { DeferInvalidation } from '../platformPublisher';
import { AiCatalogAdminServiceModelOps } from './adminService.models';
import { AiCatalogReadService } from './catalogReadService';
import {
  AiCatalogConnectionTestService,
  aiConnectionFailureCode,
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
} from './shared';
import { isOAuthAuthorizationExpiredError, refreshSharedOAuthVault } from './sharedOAuthRefresh';

type CreateProviderInput = z.infer<typeof adminAiProviderCreateDraftInputSchema>;
type UpdateProviderInput = z.infer<typeof adminAiProviderUpdateDraftInputSchema>;
type DeleteProviderInput = z.infer<typeof adminAiProviderDeleteInputSchema>;

type ConnectionTestSnapshot = {
  attemptId: string;
  model: PlatformAiModelDraftView | undefined;
  provider: PlatformAiProviderItem;
  requestedModel: string | null;
};

type ConnectionTestFinalized =
  { applied: true; result: AiConnectionTestResult } | { applied: false };

export interface AiCatalogAdminServiceOptions {
  connectionProbe?: AiConnectionProbe;
  /**
   * @internal Set only on the transaction-scoped clone built by `scopedToTransaction`.
   * Collects invalidation work so it runs after the enclosing transaction commits.
   */
  deferInvalidation?: DeferInvalidation;
  invalidation?: PlatformConfigInvalidationPublisher;
  lifecycle?: {
    afterDraftLock?: () => Promise<void>;
    /**
     * Runs inside the applyImmediate transaction, after the publish savepoint committed and
     * before the outer COMMIT — the seam for proving that a late failure rolls the whole
     * apply back and fires no invalidation.
     */
    afterApplyPublish?: () => Promise<void>;
    afterArchiveDependencyCheck?: () => Promise<void>;
    afterModelDependencyCheck?: () => Promise<void>;
    afterPublishLock?: (tx: Transaction) => Promise<void>;
  };
  resolveDependentsForModels?: typeof resolveAiCatalogDependentsForModels;
  /**
   * @internal Set only on the transaction-scoped clone built by `scopedToTransaction`.
   * Failure audits must not run on the scoped instance: written inside the transaction they
   * would roll back with it, and taking a second pooled connection while the transaction
   * holds row locks can deadlock a size-1 pool. The root instance writes exactly one failure
   * audit after the transaction settles.
   */
  suppressFailureAudit?: boolean;
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
  private readonly options: AiCatalogAdminServiceOptions;
  private readonly secretService: PlatformSecretService;

  constructor(
    db: LobeChatDatabase,
    secretService: PlatformSecretService,
    options: AiCatalogAdminServiceOptions = {},
  ) {
    super();
    this.db = db;
    this.options = options;
    this.secretService = secretService;
    this.connectionTests = new AiCatalogConnectionTestService(options.connectionProbe);
    this.lifecycle = options.lifecycle ?? {};
    this.secrets = new AiCatalogSecretManager(secretService);
    this.publication = new AiCatalogPublicationService(db, this.secrets, {
      deferInvalidation: options.deferInvalidation,
      invalidation: options.invalidation,
      lifecycle: options.lifecycle,
      resolveDependentsForModels: options.resolveDependentsForModels,
    });
  }

  /**
   * The same service bound to an open transaction.
   *
   * Drizzle turns a nested `transaction()` on a transaction handle into a SAVEPOINT, so the
   * draft write, publish validation, revision insert, pointer move and success audit of one
   * applyImmediate all commit or roll back together. Without this, a publish failure would
   * leave the very thing this design removes: a persisted draft that runtime never serves.
   */
  private scopedToTransaction = (
    tx: Transaction,
    deferInvalidation: DeferInvalidation,
  ): AiCatalogAdminService =>
    new AiCatalogAdminService(tx as unknown as LobeChatDatabase, this.secretService, {
      ...this.options,
      deferInvalidation,
      suppressFailureAudit: true,
    });

  /**
   * Run one applyImmediate unit of work in a single transaction, then invalidate the
   * process-local catalog authority token — after commit, never before.
   * On failure the transaction is rolled back and exactly one failure audit is written on the
   * root connection (the scoped instance suppresses its own).
   */
  protected runApplyTransaction = async <T>(
    params: {
      action: AuditAction;
      actorUserId: string;
      auditTargetId?: string;
      reason: string;
      secret?: AiSecretMutation;
      secretTargetId?: string;
    },
    run: (scoped: AiCatalogAdminService) => Promise<T>,
  ): Promise<T> => {
    // Nothing may announce a revision before the transaction that produced it commits: a
    // later failure would leave every cache holding an event for a revision that never
    // existed. Invalidation work is collected here and flushed only after COMMIT.
    const pendingInvalidations: Array<() => Promise<void>> = [];
    try {
      const result = await this.db.transaction(async (tx) =>
        run(this.scopedToTransaction(tx, (invalidate) => pendingInvalidations.push(invalidate))),
      );
      for (const invalidate of pendingInvalidations) await invalidate();
      invalidateAiCatalogAuthorityToken();
      return result;
    } catch (error) {
      await this.appendFailureAudit({
        action: params.action,
        actorUserId: params.actorUserId,
        reason: await this.sanitizeReason(params.reason, params.secretTargetId, params.secret),
        targetId: params.auditTargetId,
      });
      throw error;
    }
  };

  /** Model-side entry point for {@link runApplyTransaction} (see `applyModelImmediate`). */
  protected runModelApplyTransaction = <T>(
    params: {
      action: AuditAction;
      actorUserId: string;
      auditTargetId?: string;
      reason: string;
      secretTargetId?: string;
    },
    run: (scoped: AiCatalogAdminServiceModelOps) => Promise<T>,
  ): Promise<T> => this.runApplyTransaction(params, run);

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

  protected appendFailureAudit = async (params: {
    action: AuditAction;
    actorUserId: string;
    reason: string;
    targetId?: string;
  }) => {
    // Transaction-scoped clone: the root instance owns the failure audit (see options doc).
    if (this.options.suppressFailureAudit) return;
    await appendAiCatalogFailureAudit(this.db, params);
  };

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

  /**
   * Server-side revision history. Not exposed as an admin procedure (the revision-history UI
   * is gone); kept as the read side of the retained rollback capability.
   */
  listRevisionHistory = async (params: { beforeRevision?: number; id: string; limit?: number }) => {
    const repository = new PlatformAiCatalogRepository(this.db);
    if (!(await repository.getProvider(params.id))) throw new AiCatalogNotFoundError();
    return repository.listProviderRevisionMetadata({
      beforeRevision: params.beforeRevision,
      limit: params.limit,
      providerId: params.id,
    });
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

  testProvider = async (
    actorUserId: string,
    input: { id: string; model?: string; reason: string },
  ): Promise<AiConnectionTestResult> => {
    const reason = await this.sanitizeReason(input.reason, input.id);
    let finalized: ConnectionTestFinalized | undefined;
    try {
      const snapshot = await this.beginConnectionTestAttempt(input.id, input.model);
      const configurationIssue = AiCatalogAdminService.resolveCheckModelIssue(snapshot);

      let result: AiConnectionTestResult;
      if (configurationIssue) {
        result = {
          errorCategory: 'invalid_config',
          latencyMs: 0,
          sanitizedMessage: configurationIssue,
          status: 'failure',
          testedAt: new Date(),
        };
      } else {
        result = await this.runConnectionProbe(snapshot);
      }
      // CAS finalization + success/failure audit must be one transaction so a discarded
      // (superseded) probe never audits or returns as authoritative.
      finalized = await this.finalizeConnectionTest(
        input.id,
        snapshot.attemptId,
        result,
        actorUserId,
        reason,
      );
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

    return this.readSupersededConnectionTestResult(input.id);
  };

  private beginConnectionTestAttempt = async (
    id: string,
    requestedModelOverride?: string,
  ): Promise<ConnectionTestSnapshot> => {
    return this.db.transaction(async (tx) => {
      const repository = new PlatformAiCatalogRepository(tx);
      const provider = await repository.lockProvider(id);
      if (!provider) throw new AiCatalogNotFoundError();
      const draft = await new PlatformAiCatalogModel(tx).getProvider(id);
      if (!draft) throw new AiCatalogNotFoundError();
      const attemptId = randomUUID();
      const testedAt = new Date();
      const testedDraftToken = aiCatalogDraftToken(draft);
      await repository.updateProvider(id, {
        connectionTestAttemptId: attemptId,
        connectionTestErrorCategory: null,
        connectionTestLatencyMs: null,
        connectionTestSanitizedMessage: 'Connection test in progress',
        connectionTestStatus: 'pending',
        connectionTestedAt: testedAt,
        connectionTestedDraftToken: testedDraftToken,
        connectionTestedRevision: draft.revision,
      });
      // An explicit override lets the operator probe the model selected in the UI without
      // persisting it first; otherwise the provider's stored check model is used.
      const requestedModel = requestedModelOverride ?? provider.checkModel ?? null;
      const model = requestedModel
        ? draft.models.find((item) => item.modelKey === requestedModel)
        : undefined;
      return { attemptId, model, provider, requestedModel };
    });
  };

  /**
   * Distinct, sanitized reasons — one blanket "invalid provider configuration" was
   * unactionable: the operator could not tell "pick a model" from "enable the model" from
   * "the provider rejected us".
   *
   * CONTRACT WITH THE ADMIN CHECKER: it normalizes this message (lowercase,
   * non-alphanumeric → `_`) and keys actionable copy off `check_model_not_configured` /
   * `check_model_not_enabled`. Keep these two phrases normalizing to exactly those codes;
   * anything else degrades to being shown verbatim, which is the intended fallback.
   */
  private static resolveCheckModelIssue(snapshot: ConnectionTestSnapshot): string | null {
    if (!snapshot.requestedModel) return 'Check model not configured';
    // Not materialized as a platform row and explicitly disabled are the same fix for the
    // operator ("enable it for this provider"), so they share one code.
    if (!snapshot.model || !snapshot.model.enabled) return 'Check model not enabled';
    if (snapshot.model.type !== 'chat') return 'Check model is not a chat model';
    return null;
  }

  private async runConnectionProbe(
    snapshot: ConnectionTestSnapshot,
  ): Promise<AiConnectionTestResult> {
    try {
      const keyVaults = snapshot.provider.encryptedKeyVaults
        ? await this.secrets.decrypt(snapshot.provider.encryptedKeyVaults)
        : {};
      // Probe with the SAME credential a chat would use. Shared rotating-refresh vaults
      // (chatgpt/supergrok) rotate lazily on execution, so without this the admin check
      // could fail on an expired token that chat would have silently renewed. Rotation
      // happens in place at the stable fingerprint, so it is the identical secret version
      // the published revision pins.
      //
      // Isolated from the probe on purpose: refresh is PROACTIVE (it fires ~2min before
      // expiry), so a token-endpoint blip must not cancel a probe that the still-valid
      // stored access token would have passed. Only a dead grant is terminal.
      let refreshed = keyVaults;
      if (snapshot.provider.encryptedKeyVaults && snapshot.provider.secretFingerprint) {
        try {
          refreshed = await refreshSharedOAuthVault({
            ciphertext: snapshot.provider.encryptedKeyVaults,
            db: this.db,
            fingerprint: snapshot.provider.secretFingerprint,
            keyVaults,
            providerKey: snapshot.provider.providerKey,
            providerRowId: snapshot.provider.id,
            secrets: this.secrets,
          });
        } catch (error) {
          if (isOAuthAuthorizationExpiredError(error)) throw error;
          // Transient — keep the stored vault and let the probe be the real verdict.
          refreshed = keyVaults;
        }
      }
      const normalized = normalizeAiCatalogExecutionCredentials({
        config: snapshot.provider.config,
        keyVaults: refreshed,
        providerKey: snapshot.provider.providerKey,
        source: snapshot.provider.source,
        settings: snapshot.provider.settings,
      });
      /**
       * Every runtime that presents an installation identity upstream gets the SAME
       * persisted profile the chat path uses — a probe that goes out as a different
       * device than production is not a probe of production (and for Grok a missing
       * profile used to mean the package's constant agent id).
       */
      const browserProfile = await resolvePlatformBrowserProfile(
        this.db,
        normalized.runtimeProvider,
      );
      return await this.connectionTests.test({
        browserProfile,
        keyVaults: normalized.keyVaults,
        model: snapshot.model!.modelKey,
        provider: snapshot.provider,
        runtimeProvider: normalized.runtimeProvider,
      });
    } catch (error) {
      // A dead shared grant is its own actionable state, not a generic config error.
      // Same stable codes as the probe itself (`llm.checker.reason.*`): this branch used to
      // mint English prose that every locale rendered verbatim, and the shared-account code
      // is what survives into persisted state for a superseded attempt to replay.
      const expired = isOAuthAuthorizationExpiredError(error);
      return {
        errorCategory: expired ? 'auth' : 'invalid_config',
        ...(expired ? { errorType: 'OAuthAuthorizationExpired' as const } : {}),
        latencyMs: 0,
        sanitizedMessage: aiConnectionFailureCode(
          expired ? 'auth' : 'invalid_config',
          expired ? 'OAuthAuthorizationExpired' : undefined,
        ),
        status: 'failure',
        testedAt: new Date(),
      };
    }
  }

  private async finalizeConnectionTest(
    id: string,
    attemptId: string,
    result: AiConnectionTestResult,
    actorUserId: string,
    reason: string,
  ): Promise<ConnectionTestFinalized> {
    return this.db.transaction(async (tx) => {
      const applied = await new PlatformAiCatalogRepository(tx).completeProviderConnectionTest(
        id,
        attemptId,
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
        targetId: id,
        targetType: 'provider',
      });
      return { applied: true as const, result };
    });
  }

  private async readSupersededConnectionTestResult(id: string): Promise<AiConnectionTestResult> {
    // Superseded attempt (CAS no-op): return the authoritative persisted state without auditing.
    const detail = await new PlatformAiCatalogModel(this.db).getProvider(id);
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
  }

  publishProvider: AiCatalogPublicationService['publishProvider'] = (actorUserId, input) =>
    this.publication.publishProvider(actorUserId, input);

  archiveProvider: AiCatalogPublicationService['archiveProvider'] = (actorUserId, input) =>
    this.publication.archiveProvider(actorUserId, input);

  /**
   * Restore a previous published revision. Not exposed as an admin procedure — the
   * draft/publish/rollback UI is gone — but retained as a server-side recovery capability
   * over the immutable revision log.
   */
  rollbackProvider: AiCatalogPublicationService['rollbackProvider'] = (actorUserId, input) =>
    this.publication.rollbackProvider(actorUserId, input);

  /**
   * Publish the current draft of `providerId` under its live CAS identity.
   *
   * There is no draft/publish workflow any more: every admin write ends here, and a publish
   * failure is a hard error (the caller sees a toast) rather than a leftover visible draft.
   */
  protected publishAfterMutation = async (
    actorUserId: string,
    providerId: string,
    reason: string,
  ): Promise<{ auditId: string; revision: number }> => {
    const detail = await this.getDetail(providerId);
    return this.publishProvider(actorUserId, {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: providerId,
      reason,
    });
  };

  /**
   * Apply a provider mutation and publish it — atomically.
   *
   * The draft write and the publish share ONE transaction, so a validation failure rolls the
   * write back: a failed create leaves no provider row (a retry cannot duplicate it) and a
   * failed update leaves the stored draft exactly as runtime already serves it. Success ⇒ the
   * change is live site-wide.
   *
   * Two concurrent admins are still last-write-wins (user-page parity); the draftToken /
   * expectedRevision CAS is the only serialization, and it guarantees that what gets published
   * is what this transaction itself wrote.
   */
  applyProviderImmediate = async (
    actorUserId: string,
    input: (CreateProviderInput & { mode: 'create' }) | (UpdateProviderInput & { mode: 'update' }),
  ) => {
    const { providerId, published } = await this.runApplyTransaction(
      {
        action: 'admin.aiProviders.applyImmediate',
        actorUserId,
        auditTargetId: input.mode === 'create' ? input.providerKey : input.id,
        reason: input.reason,
        secret: input.secret,
        secretTargetId: input.mode === 'update' ? input.id : undefined,
      },
      async (scoped) => {
        let providerId: string;
        if (input.mode === 'create') {
          const { mode: _mode, ...createInput } = input;
          providerId = (await scoped.createProviderDraft(actorUserId, createInput)).id;
          // A builtin provider's card already renders its default-enabled models with the
          // toggle ON, so the row-less state the create used to leave behind was a lie the
          // connectivity check then exposed. Seed those models here — same transaction, so
          // the provider and its catalog become live together or not at all.
          if (createInput.source === 'builtin') {
            await scoped.materializeBuiltinDefaultModels(actorUserId, {
              providerId,
              providerKey: createInput.providerKey,
              reason: input.reason,
            });
          }
        } else {
          const { mode: _mode, ...updateInput } = input;
          await scoped.updateProviderDraft(actorUserId, updateInput);
          providerId = input.id;
        }
        const published = await scoped.publishAfterMutation(actorUserId, providerId, input.reason);
        await this.lifecycle.afterApplyPublish?.();
        return { providerId, published };
      },
    );

    const after = await this.getDetail(providerId);
    return {
      auditId: published.auditId,
      draft: after.draft,
      revision: published.revision,
    };
  };
}

export {
  type AiCatalogDependent,
  AiCatalogNotFoundError,
  AiCatalogPermissionDeniedError,
  AiCatalogResourceInUseError,
  AiCatalogValidationError,
} from './errors';
