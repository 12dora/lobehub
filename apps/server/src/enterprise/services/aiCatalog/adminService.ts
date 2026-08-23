import type { z } from 'zod';

import {
  PlatformAiCatalogModel,
  type PlatformAiProviderDraftView,
} from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  type adminAiProviderCreateDraftInputSchema,
  type adminAiProviderUpdateDraftInputSchema,
} from '../../contracts/aiCatalog';
import type { PlatformSecretService } from '../../security/secret';
import type { AuditAction } from '../audit/auditActionCatalog';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { invalidateAiCatalogAuthorityToken } from '../platformInstance/catalogTokens';
import type { DeferInvalidation } from '../platformPublisher';
import { AiCatalogAdminServiceConnectionTestOps } from './adminService.connectionTest';
import { toProviderDraft } from './adminService.draft';
import { AiCatalogReadService } from './catalogReadService';
import { AiCatalogConnectionTestService, type AiConnectionProbe } from './connectionTestService';
import type { resolveAiCatalogDependentsForModels } from './dependencies';
import { AiCatalogNotFoundError } from './errors';
import { sanitizeAiCatalogPersistedText } from './persistentText';
import { AiCatalogPublicationService } from './publication';
import { AiCatalogSecretManager, type AiSecretMutation } from './secretManager';
import {
  aiCatalogDraftToken,
  appendAiCatalogFailureAudit,
  getLockedAiCatalogDraft,
} from './shared';

type CreateProviderInput = z.infer<typeof adminAiProviderCreateDraftInputSchema>;
type UpdateProviderInput = z.infer<typeof adminAiProviderUpdateDraftInputSchema>;

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

export class AiCatalogAdminService extends AiCatalogAdminServiceConnectionTestOps {
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
  private scopedToTransaction = (tx: Transaction, deferInvalidation: DeferInvalidation): this => {
    const Service = this.constructor as new (
      db: LobeChatDatabase,
      secretService: PlatformSecretService,
      options?: AiCatalogAdminServiceOptions,
    ) => this;
    return new Service(tx as unknown as LobeChatDatabase, this.secretService, {
      ...this.options,
      deferInvalidation,
      suppressFailureAudit: true,
    });
  };

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
    run: (scoped: this) => Promise<T>,
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
    run: (scoped: this) => Promise<T>,
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
    force?: boolean,
  ): Promise<{ auditId: string; revision: number }> => {
    const detail = await this.getDetail(providerId);
    return this.publishProvider(actorUserId, {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      ...(force ? { force: true } : {}),
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
        const published = await scoped.publishAfterMutation(
          actorUserId,
          providerId,
          input.reason,
          input.mode === 'update' ? input.force : undefined,
        );
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
  AiCatalogCannotEnumerateError,
  type AiCatalogDependent,
  AiCatalogNotFoundError,
  AiCatalogPermissionDeniedError,
  AiCatalogResourceInUseError,
  AiCatalogUpstreamSyncError,
  AiCatalogValidationError,
} from './errors';
