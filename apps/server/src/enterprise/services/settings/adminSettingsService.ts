/**
 * Admin settings service (M05).
 *
 * TRPC surface: `getDraft` (read), `save` (de-drafted immediate site-wide write) and
 * `applyImmediate` (path→value patch used by the AI settings forms). `saveDraft`,
 * `validateDraft`, `publish` and `rollback` survive only as internal building blocks —
 * they have no procedure and must not grow one back.
 *
 * Aggregate resource: resourceType=settings, resourceId=global.
 * Uses PlatformPublisherService for atomic revision + audit + invalidation.
 */

import {
  checksumPayload,
  createSettingsPointerAdapter,
  PlatformSettingsModel,
  type SettingsDraftPolicyMap,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import {
  PLATFORM_SETTINGS_RESOURCE_ID,
  PLATFORM_SETTINGS_RESOURCE_TYPE,
  type SettingPolicyMode,
  type SettingPolicyVisibility,
} from '@/types/platform/settings';

import { classifyEnterpriseError } from '../../observability';
import type { AuditAction } from '../audit/auditActionCatalog';
import {
  type AppendPlatformAuditLogParams,
  type PlatformAuditLogItem,
  PlatformAuditService,
} from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import {
  acquirePlatformDependencyPublicationLock,
  assertPublishedPlatformAiReferences,
} from '../platformDependencyLock';
import { PlatformPublisherService, PlatformRevisionConflictError } from '../platformPublisher';
import { applySettingsPatch } from './applySettingsPatch';
import { validateSettingsDraft } from './draftValidation';
import { SettingsDirtyDraftError, SettingsDraftValidationError } from './errors';
import {
  isServiceModelManagedPath,
  mergePolicyEditorDraft,
  overlayCurrentForeignPolicies,
  preserveForeignPublishedInDraft,
} from './policyEditorOwnership';
import { settingsRegistry } from './registry';

export { PlatformRevisionConflictError };
export { SettingsDirtyDraftError, SettingsDraftValidationError } from './errors';

/** Production-empty lifecycle seam for causal transaction fault tests. */
export interface AdminSettingsMutationLifecycle {
  afterDraftLock?: () => Promise<void>;
  afterMaterialization?: (operation: 'publish' | 'rollback') => Promise<void>;
}

export interface AdminSettingsServiceOptions {
  auditAppend?: (
    db: LobeChatDatabase | Transaction,
    params: AppendPlatformAuditLogParams,
  ) => Promise<PlatformAuditLogItem>;
  invalidation?: PlatformConfigInvalidationPublisher;
  lifecycle?: AdminSettingsMutationLifecycle;
}

const policyToMapEntry = (p: {
  mode: SettingPolicyMode | string;
  schemaVersion: number;
  value: unknown;
  visibility?: SettingPolicyVisibility | string | null;
}) => ({
  mode: p.mode as SettingPolicyMode,
  schemaVersion: p.schemaVersion,
  value: p.value,
  visibility: (p.visibility ?? 'visible') as SettingPolicyVisibility,
});

export class AdminSettingsService {
  private readonly db: LobeChatDatabase;
  private readonly model: PlatformSettingsModel;
  private readonly publisher: PlatformPublisherService;
  private readonly auditAppend: NonNullable<AdminSettingsServiceOptions['auditAppend']>;
  private readonly lifecycle: AdminSettingsMutationLifecycle;

  private draftToken = (bundle: { draft: unknown; revision: number }): string =>
    checksumPayload({ draft: bundle.draft ?? {}, revision: bundle.revision });

  constructor(db: LobeChatDatabase, options: AdminSettingsServiceOptions = {}) {
    this.db = db;
    this.model = new PlatformSettingsModel(db);
    this.publisher = new PlatformPublisherService(db, options.invalidation);
    this.auditAppend =
      options.auditAppend ??
      ((auditDb, params) => new PlatformAuditService(auditDb).append(params));
    this.lifecycle = options.lifecycle ?? {};
  }

  /** Build pointer that materializes path policies inside the publish/rollback transaction. */
  private settingsPointer = (params: {
    alignDraft?: boolean;
    expectedDraftToken: string;
    /**
     * De-drafted `save` only: the policy-editor payload published in this transaction.
     * The baseline is the **published** policy set, never the (possibly stranded) draft
     * column, so a legacy unpublished draft is dropped instead of silently adopted.
     */
    incoming?: SettingsDraftPolicyMap;
    /**
     * `alignDraft` only: receives the CAS token of the draft row this transaction wrote,
     * computed from the committed revision. Callers must build their response from this
     * instead of re-reading the bundle after COMMIT (an unlocked post-commit read can
     * observe a newer save and pair revision N with the token of revision N+1).
     */
    onDraftAligned?: (draftToken: string) => void;
    operation: 'publish' | 'rollback';
    /**
     * Publish only: `policy-editor` re-attaches missing foreign published rows so empty
     * policy-editor drafts cannot wipe service-model policies. `full` materializes the
     * draft as a whole-table replacement (intentional foreign deletes are allowed).
     * Rollback always overlays current foreign rows (ownership is path-based, not actor).
     */
    ownership?: 'full' | 'policy-editor';
    updatedBy?: string | null;
  }) =>
    createSettingsPointerAdapter({
      assertLockedState: async (tx) => {
        await acquirePlatformDependencyPublicationLock(tx);
        const model = new PlatformSettingsModel(tx);
        const bundle = await model.getBundle();
        if (!bundle) throw new Error('Failed to load locked platform settings bundle');
        if (this.draftToken(bundle) !== params.expectedDraftToken) {
          throw new PlatformRevisionConflictError(
            'Platform settings draft conflict: expectedDraftToken does not match locked draft',
          );
        }
        // `incoming` replaces the draft column wholesale, so a stranded draft referencing
        // a retired provider must not block the save; materialize re-asserts on the
        // policies actually being published.
        if (!params.incoming) await assertPublishedPlatformAiReferences(tx, bundle.draft);
      },
      materializePublished: async (tx, args) => {
        const model = new PlatformSettingsModel(tx);
        let policies = ((args.payload as { policies?: SettingsDraftPolicyMap }).policies ??
          {}) as SettingsDraftPolicyMap;
        const published = await model.listPublishedPolicies();
        if (params.operation === 'publish') {
          // Only policy-editor publishes preserve missing foreign rows. Full ownership
          // is a whole-table replacement (documented on saveDraft / publish).
          if (params.ownership === 'policy-editor') {
            policies = preserveForeignPublishedInDraft(policies, published);
          }
        } else {
          // Rollback: restore owned paths from history, keep current foreign rows byte-identical.
          policies = overlayCurrentForeignPolicies(policies, published);
        }
        await assertPublishedPlatformAiReferences(tx, policies);
        await model.replacePublishedPolicies({
          draft: policies,
          revision: args.revision,
          updatedBy: params.updatedBy,
        });
        if (params.alignDraft) {
          const aligned = await model.saveDraft({
            draft: policies,
            updatedBy: params.updatedBy,
          });
          // Same transaction, same lock: `aligned.draft` is the stored row a later
          // `getDraft()` would read, and `args.revision` is the revision the pointer was
          // just moved to — so this token can never belong to somebody else's revision.
          params.onDraftAligned?.(
            this.draftToken({
              draft: (aligned?.draft ?? policies) as SettingsDraftPolicyMap,
              revision: args.revision,
            }),
          );
        }
        await this.lifecycle.afterMaterialization?.(params.operation);
      },
      prepareLockedPublish: async (tx) => {
        const model = new PlatformSettingsModel(tx);
        const bundle = await model.getBundle();
        if (!bundle) throw new Error('Failed to load locked platform settings bundle');
        let draft = (bundle.draft ?? {}) as SettingsDraftPolicyMap;
        if (params.incoming) {
          // De-drafted save: owned paths come from the payload, foreign service-model
          // paths from the current PUBLISHED state (R1 + R5).
          const publishedBase: SettingsDraftPolicyMap = {};
          for (const row of await model.listPublishedPolicies()) {
            publishedBase[row.path] = policyToMapEntry(row);
          }
          draft = mergePolicyEditorDraft(publishedBase, params.incoming);
        }
        // Policy-editor only: re-attach foreign published paths absent from the draft so
        // empty/partial policy-editor drafts cannot wipe service-model policies.
        // Full ownership leaves the draft unchanged (intentional foreign deletes stick).
        if (params.ownership === 'policy-editor') {
          const published = await model.listPublishedPolicies();
          draft = preserveForeignPublishedInDraft(draft, published);
        }
        const validation = await validateSettingsDraft(draft, model);
        if (!validation.ok) throw new SettingsDraftValidationError(validation.issues);

        return {
          afterDiff: {
            pathCount: Object.keys(draft).length,
            paths: Object.fromEntries(
              Object.entries(draft).map(([path, policy]) => [
                path,
                { mode: policy.mode, visibility: policy.visibility },
              ]),
            ),
          },
          payload: {
            policies: draft,
            registryVersion: settingsRegistry.version,
          },
        };
      },
      updatedBy: params.updatedBy,
    });

  getDraft = async () => {
    const bundle = await this.model.ensureBundle();
    const published = await this.model.listPublishedPolicies();
    const publishedPolicies: SettingsDraftPolicyMap = {};
    for (const row of published) {
      publishedPolicies[row.path] = policyToMapEntry(row);
    }

    return {
      baseRevision: bundle.revision,
      draft: (bundle.draft ?? {}) as SettingsDraftPolicyMap,
      draftToken: this.draftToken(bundle),
      publishedPolicies,
      registry: settingsRegistry.list().map((e) => ({
        builtInDefault: e.builtInDefault,
        control: e.control,
        descriptionKey: e.descriptionKey,
        group: e.group,
        max: e.max,
        min: e.min,
        options: e.options ? [...e.options] : undefined,
        path: e.path,
        schemaVersion: e.schemaVersion,
        step: e.step,
        titleKey: e.titleKey,
      })),
      registryVersion: settingsRegistry.version,
      status: bundle.status as 'draft' | 'published' | 'archived',
    };
  };

  /**
   * De-drafted 统一管理 write: apply a policy-editor payload site-wide immediately.
   *
   * ONE publisher transaction: lock bundle → CAS (`expectedRevision` + `expectedDraftToken`)
   * → merge owned paths over the **published** baseline (`mergePolicyEditorDraft`, ownership
   * `policy-editor`) → validate → materialize published + align the draft column → audit →
   * COMMIT → invalidate scope `settings` (the publisher only emits after commit).
   *
   * An empty `policies` map is 恢复默认 **for owned paths only** — service-model rows
   * (`image.*`, `systemAgent.*`, …) are re-attached from published and never deleted (R1).
   * Foreign paths present in `policies` are ignored and reported via `warnings`.
   */
  save = async (params: {
    actorUserId: string;
    comment?: string;
    expectedDraftToken: string;
    expectedRevision: number;
    policies: SettingsDraftPolicyMap;
    reason: string;
  }) => {
    await this.model.ensureBundle();

    const ignoredForeignPathCount = Object.keys(params.policies).filter((path) =>
      isServiceModelManagedPath(path),
    ).length;
    const owned = Object.fromEntries(
      Object.entries(params.policies).filter(([path]) => !isServiceModelManagedPath(path)),
    ) as SettingsDraftPolicyMap;

    // Pre-validate the caller's own paths so validation errors point at the admin's edit
    // rather than at a foreign row merged in under the lock.
    const prevalidation = await this.validateDraft(owned);
    if (!prevalidation.ok) {
      const error = new SettingsDraftValidationError(prevalidation.issues);
      await this.appendFailureAudit({
        action: 'admin.settings.save',
        actorUserId: params.actorUserId,
        beforeDiff: { expectedRevision: params.expectedRevision },
        error,
        reason: params.reason,
      });
      throw error;
    }

    let saveAuditId: string | undefined;
    let committedDraftToken: string | undefined;
    let revision: number;
    try {
      const result = await this.publisher.publish({
        actorUserId: params.actorUserId,
        beforeDiff: { revision: params.expectedRevision },
        comment: params.comment ?? params.reason,
        expectedRevision: params.expectedRevision,
        // Admin-facing audit committed atomically with the revision it describes.
        finalizeSuccess: async (tx, committed) => {
          const audit = await this.auditAppend(tx, {
            action: 'admin.settings.save',
            actorUserId: params.actorUserId,
            afterDiff: {
              ownedPathCount: Object.keys(owned).length,
              paths: Object.fromEntries(
                Object.entries(owned).map(([path, policy]) => [
                  path,
                  { mode: policy.mode, visibility: policy.visibility },
                ]),
              ),
              revision: committed.revision,
            },
            beforeDiff: { revision: params.expectedRevision },
            configRevision: committed.revision,
            reason: params.reason,
            result: 'success',
            targetId: PLATFORM_SETTINGS_RESOURCE_ID,
            targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
          });
          saveAuditId = audit.id;
        },
        invalidationScopes: ['settings'],
        // Replaced by prepareLockedPublish after the settings bundle lock.
        payload: {},
        pointer: this.settingsPointer({
          alignDraft: true,
          expectedDraftToken: params.expectedDraftToken,
          incoming: owned,
          onDraftAligned: (token) => {
            committedDraftToken = token;
          },
          operation: 'publish',
          ownership: 'policy-editor',
          updatedBy: params.actorUserId,
        }),
        reason: params.reason,
        resourceId: PLATFORM_SETTINGS_RESOURCE_ID,
        resourceType: PLATFORM_SETTINGS_RESOURCE_TYPE,
      });
      revision = result.revision.revision;
      saveAuditId ??= result.auditId;
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.settings.save',
        actorUserId: params.actorUserId,
        beforeDiff: { expectedRevision: params.expectedRevision },
        error,
        reason: params.reason,
      });
      throw error;
    }

    // Both are set inside the committed transaction (`finalizeSuccess` / `alignDraft`), so the
    // response describes exactly this revision — no post-commit read that a concurrent save
    // could race, and no post-commit failure after a site-wide write already landed.
    return {
      auditId: saveAuditId!,
      draftToken: committedDraftToken!,
      revision,
      ...(ignoredForeignPathCount > 0
        ? { warnings: [`ignored_service_model_paths:${ignoredForeignPathCount}`] }
        : {}),
    };
  };

  /**
   * Validate entire draft bundle. Fail-closed on unknown/secret/wrong-type paths.
   * @internal no TRPC surface — reachable through `save` / `applyImmediate` only.
   */
  validateDraft = async (draft: SettingsDraftPolicyMap) => validateSettingsDraft(draft, this.model);

  /**
   * @internal Draft-only write with no TRPC surface. Kept because `applyImmediate`
   * composes it with `publish`, and because seeding tests need full-ownership writes.
   */
  saveDraft = async (params: {
    actorUserId: string;
    draft: SettingsDraftPolicyMap;
    expectedDraftToken: string;
    /**
     * `policy-editor` (TRPC admin settings page): only owned paths may change; foreign
     * service-model rows are preserved from the locked draft.
     * `full` (applyImmediate / internal): whole-table replacement.
     */
    ownership?: 'full' | 'policy-editor';
    reason: string;
  }) => {
    const ownership = params.ownership ?? 'full';

    // Pre-validate client payload. For policy-editor, only owned paths are validated here;
    // foreign keys are ignored by the merge and re-validated with the locked draft below.
    const draftToPrevalidate =
      ownership === 'policy-editor'
        ? (Object.fromEntries(
            Object.entries(params.draft).filter(([path]) => !isServiceModelManagedPath(path)),
          ) as SettingsDraftPolicyMap)
        : params.draft;
    {
      const validation = await this.validateDraft(draftToPrevalidate);
      if (!validation.ok) {
        await this.auditAppend(this.db, {
          action: 'admin.settings.saveDraft',
          actorUserId: params.actorUserId,
          afterDiff: { issueCount: validation.issues.length },
          beforeDiff: null,
          reason: params.reason,
          result: 'failure',
          targetId: PLATFORM_SETTINGS_RESOURCE_ID,
          targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
        });
        throw new SettingsDraftValidationError(validation.issues);
      }
    }

    // Atomic: draft write + success audit in one transaction
    let bundle: Awaited<ReturnType<PlatformSettingsModel['saveDraft']>>;
    try {
      bundle = await this.db.transaction(async (tx) => {
        const model = new PlatformSettingsModel(tx);
        await model.lockBundleForUpdate();
        await this.lifecycle.afterDraftLock?.();
        const current = await model.getBundle();
        if (!current) throw new Error('Failed to load locked platform settings bundle');
        if (this.draftToken(current) !== params.expectedDraftToken) {
          throw new PlatformRevisionConflictError(
            'Platform settings draft conflict: expectedDraftToken does not match current draft',
          );
        }

        const currentDraft = (current.draft ?? {}) as SettingsDraftPolicyMap;
        const nextDraft =
          ownership === 'policy-editor'
            ? mergePolicyEditorDraft(currentDraft, params.draft)
            : params.draft;

        // Re-validate merged bundle under the lock (foreign rows + owned changes).
        if (ownership === 'policy-editor') {
          const validation = await validateSettingsDraft(nextDraft, model);
          if (!validation.ok) {
            throw new SettingsDraftValidationError(validation.issues);
          }
        }

        const saved = await model.saveDraft({
          draft: nextDraft,
          updatedBy: params.actorUserId,
        });
        await this.auditAppend(tx, {
          action: 'admin.settings.saveDraft',
          actorUserId: params.actorUserId,
          afterDiff: {
            ownership,
            pathCount: Object.keys(nextDraft).length,
            paths: Object.fromEntries(
              Object.entries(nextDraft).map(([path, p]) => [
                path,
                { mode: p.mode, visibility: p.visibility },
              ]),
            ),
          },
          beforeDiff: null,
          reason: params.reason,
          result: 'success',
          targetId: PLATFORM_SETTINGS_RESOURCE_ID,
          targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
        });
        return saved;
      });
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.settings.saveDraft',
        actorUserId: params.actorUserId,
        beforeDiff: null,
        error,
        reason: params.reason,
      });
      throw error;
    }

    return {
      baseRevision: bundle.revision,
      draftToken: this.draftToken(bundle),
      ok: true as const,
      registryVersion: settingsRegistry.version,
    };
  };

  /**
   * Merge a path→value patch into the draft and publish immediately (W10-C).
   * Body lives in `applySettingsPatch.ts`; it composes the internal saveDraft + publish.
   */
  applyImmediate = async (params: {
    actorUserId: string;
    patch: Record<string, unknown>;
    reason?: string;
  }) =>
    applySettingsPatch(
      {
        appendAudit: this.auditAppend,
        db: this.db,
        getDraft: this.getDraft,
        publish: this.publish,
        saveDraft: this.saveDraft,
      },
      params,
    );

  publish = async (params: {
    actorUserId: string;
    comment?: string;
    expectedDraftToken: string;
    expectedRevision: number;
    /**
     * `policy-editor` (TRPC admin settings page): re-attach missing foreign published rows.
     * `full` (default — applyImmediate / internal whole-table): draft is authoritative;
     * omitted foreign paths are deleted from `platform_setting_policies` on materialize.
     */
    ownership?: 'full' | 'policy-editor';
    reason: string;
  }) => {
    await this.model.ensureBundle();
    const ownership = params.ownership ?? 'full';

    try {
      // Single transaction: revision + pointer + materialize policies + success audit;
      // invalidation only after commit (publisher already does this).
      const result = await this.publisher.publish({
        actorUserId: params.actorUserId,
        beforeDiff: { revision: params.expectedRevision },
        comment: params.comment ?? params.reason,
        expectedRevision: params.expectedRevision,
        invalidationScopes: ['settings'],
        // Replaced by prepareLockedPublish after the settings bundle lock.
        payload: {},
        pointer: this.settingsPointer({
          expectedDraftToken: params.expectedDraftToken,
          operation: 'publish',
          ownership,
          updatedBy: params.actorUserId,
        }),
        reason: params.reason,
        resourceId: PLATFORM_SETTINGS_RESOURCE_ID,
        resourceType: PLATFORM_SETTINGS_RESOURCE_TYPE,
      });

      return {
        auditId: result.auditId,
        revision: result.revision.revision,
      };
    } catch (error) {
      // Failure audit after rollback of the publish transaction
      await this.appendFailureAudit({
        action: 'admin.settings.publish',
        actorUserId: params.actorUserId,
        beforeDiff: { expectedRevision: params.expectedRevision },
        error,
        reason: params.reason,
      });
      throw error;
    }
  };

  rollback = async (params: {
    actorUserId: string;
    expectedDraftToken: string;
    expectedRevision: number;
    reason: string;
    targetRevision: number;
  }) => {
    try {
      const result = await this.publisher.rollback({
        actorUserId: params.actorUserId,
        expectedRevision: params.expectedRevision,
        invalidationScopes: ['settings'],
        pointer: this.settingsPointer({
          alignDraft: true,
          expectedDraftToken: params.expectedDraftToken,
          operation: 'rollback',
          updatedBy: params.actorUserId,
        }),
        reason: params.reason,
        resourceId: PLATFORM_SETTINGS_RESOURCE_ID,
        resourceType: PLATFORM_SETTINGS_RESOURCE_TYPE,
        targetRevision: params.targetRevision,
      });

      return {
        auditId: result.auditId,
        revision: result.revision.revision,
      };
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.settings.rollback',
        actorUserId: params.actorUserId,
        beforeDiff: {
          expectedRevision: params.expectedRevision,
          targetRevision: params.targetRevision,
        },
        error,
        reason: params.reason,
      });
      throw error;
    }
  };

  /**
   * Bounded, secret-safe failure category for operational diagnosis.
   * Never includes raw exceptions, draft tokens, or setting values.
   */
  private publishFailureCategory = (error: unknown): string => {
    if (error instanceof PlatformRevisionConflictError) return 'revision_conflict';
    if (error instanceof SettingsDraftValidationError) return 'validation';
    if (error instanceof SettingsDirtyDraftError) return 'dirty_draft';
    // DB / network unavailability and timeouts get a dedicated category so publish-health
    // aggregation can separate availability incidents from unexpected internal faults.
    const enterpriseClass = classifyEnterpriseError(error);
    if (enterpriseClass === 'UnavailableError' || enterpriseClass === 'TimeoutError') {
      return 'availability';
    }
    return 'internal';
  };

  /**
   * Failure audit runs only after the state transaction has rolled back. Audit
   * storage failure is deliberately non-recursive and never turns into success.
   */
  private appendFailureAudit = async (params: {
    action: AuditAction;
    actorUserId: string;
    beforeDiff: Record<string, unknown> | null;
    error?: unknown;
    reason: string;
  }): Promise<void> => {
    try {
      await this.auditAppend(this.db, {
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: params.error ? { error: this.publishFailureCategory(params.error) } : null,
        beforeDiff: params.beforeDiff,
        reason: params.reason,
        result: 'failure',
        targetId: PLATFORM_SETTINGS_RESOURCE_ID,
        targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
      });
    } catch (auditError) {
      console.error('[admin.settings:auditFailure]', {
        action: params.action,
        error: auditError instanceof Error ? auditError.message : 'unknown',
      });
    }
  };
}
