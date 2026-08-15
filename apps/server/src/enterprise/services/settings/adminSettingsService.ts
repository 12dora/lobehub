/**
 * Admin settings service (M05).
 *
 * TRPC surface: `getDraft` (read), `save` (de-drafted immediate site-wide write) and
 * `applyImmediate` (path→value patch used by the AI settings forms). Both writes share
 * ONE transaction body (`applyPolicies`): lock → CAS → merge → validate → materialize +
 * align draft → audit → COMMIT → invalidate. There is no draft workflow left — the
 * removed `saveDraft` / `publish` / `rollback` steps must not grow back.
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
import { SettingsDraftValidationError } from './errors';
import {
  isServiceModelManagedPath,
  mergePolicyEditorDraft,
  preserveForeignPublishedInDraft,
} from './policyEditorOwnership';
import { settingsRegistry } from './registry';

export { PlatformRevisionConflictError };
export { SettingsDirtyDraftError, SettingsDraftValidationError } from './errors';

/** Production-empty lifecycle seam for causal transaction fault tests. */
export interface AdminSettingsMutationLifecycle {
  afterMaterialization?: () => Promise<void>;
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

  /** Build the pointer that materializes path policies inside the write transaction. */
  private settingsPointer = (params: {
    expectedDraftToken: string;
    /**
     * The payload published in this transaction. `policy-editor` merges it over the
     * **published** policy set (never the possibly stranded draft column, so a legacy
     * unpublished draft is dropped instead of silently adopted); `full` treats it as the
     * authoritative whole-table map.
     */
    incoming: SettingsDraftPolicyMap;
    /**
     * Receives the CAS token of the draft row this transaction wrote, computed from the
     * committed revision. Callers must build their response from this instead of
     * re-reading the bundle after COMMIT (an unlocked post-commit read can observe a
     * newer save and pair revision N with the token of revision N+1).
     */
    onDraftAligned: (draftToken: string) => void;
    /**
     * `policy-editor` (统一管理 save) re-attaches missing foreign published rows so an
     * empty/partial policy-editor payload cannot wipe service-model policies.
     * `full` (applyImmediate) materializes the payload as a whole-table replacement.
     */
    ownership: 'full' | 'policy-editor';
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
        // No AI-reference assertion here: `incoming` replaces the draft column wholesale,
        // so a stranded draft referencing a retired provider must not block the write.
        // `materializePublished` asserts references on the policies actually published.
      },
      materializePublished: async (tx, args) => {
        const model = new PlatformSettingsModel(tx);
        let policies = ((args.payload as { policies?: SettingsDraftPolicyMap }).policies ??
          {}) as SettingsDraftPolicyMap;
        if (params.ownership === 'policy-editor') {
          // Only policy-editor writes preserve missing foreign rows. Full ownership is a
          // whole-table replacement (applyImmediate already carries published forward).
          policies = preserveForeignPublishedInDraft(policies, await model.listPublishedPolicies());
        }
        await assertPublishedPlatformAiReferences(tx, policies);
        await model.replacePublishedPolicies({
          draft: policies,
          revision: args.revision,
          updatedBy: params.updatedBy,
        });
        const aligned = await model.saveDraft({
          draft: policies,
          updatedBy: params.updatedBy,
        });
        // Same transaction, same lock: `aligned.draft` is the stored row a later
        // `getDraft()` would read, and `args.revision` is the revision the pointer was
        // just moved to — so this token can never belong to somebody else's revision.
        params.onDraftAligned(
          this.draftToken({
            draft: (aligned?.draft ?? policies) as SettingsDraftPolicyMap,
            revision: args.revision,
          }),
        );
        await this.lifecycle.afterMaterialization?.();
      },
      prepareLockedPublish: async (tx) => {
        const model = new PlatformSettingsModel(tx);
        let draft = params.incoming;
        if (params.ownership === 'policy-editor') {
          // Owned paths come from the payload, foreign service-model paths from the
          // current PUBLISHED state (R1 + R5), then re-attach foreign published paths
          // absent from the merge so a partial payload cannot delete them.
          const published = await model.listPublishedPolicies();
          const publishedBase: SettingsDraftPolicyMap = {};
          for (const row of published) {
            publishedBase[row.path] = policyToMapEntry(row);
          }
          draft = preserveForeignPublishedInDraft(
            mergePolicyEditorDraft(publishedBase, params.incoming),
            published,
          );
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

    const committed = await this.applyPolicies({
      action: 'admin.settings.save',
      actorUserId: params.actorUserId,
      auditAfterDiff: (revision) => ({
        ownedPathCount: Object.keys(owned).length,
        paths: Object.fromEntries(
          Object.entries(owned).map(([path, policy]) => [
            path,
            { mode: policy.mode, visibility: policy.visibility },
          ]),
        ),
        revision,
      }),
      comment: params.comment,
      expectedDraftToken: params.expectedDraftToken,
      expectedRevision: params.expectedRevision,
      incoming: owned,
      ownership: 'policy-editor',
      reason: params.reason,
    });

    return {
      ...committed,
      ...(ignoredForeignPathCount > 0
        ? { warnings: [`ignored_service_model_paths:${ignoredForeignPathCount}`] }
        : {}),
    };
  };

  /**
   * Merge a path→value patch into the published policy set and apply it immediately
   * (W10-C, AI settings forms). Body lives in `applySettingsPatch.ts`; it computes the
   * next whole-table map and hands it to the same single transaction `save` uses.
   */
  applyImmediate = async (params: {
    actorUserId: string;
    patch: Record<string, unknown>;
    reason?: string;
  }) =>
    applySettingsPatch(
      {
        appendAudit: this.auditAppend,
        applyPolicies: this.applyPolicies,
        db: this.db,
        getDraft: this.getDraft,
      },
      params,
    );

  /**
   * Validate an entire policy map. Fail-closed on unknown/secret/wrong-type paths.
   * @internal no TRPC surface — reachable through `save` / `applyImmediate` only.
   */
  validateDraft = async (draft: SettingsDraftPolicyMap) => validateSettingsDraft(draft, this.model);

  /**
   * The single write transaction behind `save` and `applyImmediate`.
   *
   * lock bundle + dependency lock → CAS (`expectedRevision` + `expectedDraftToken`) →
   * ownership merge → validate → materialize published + align the draft column →
   * success audit (same transaction) → COMMIT → invalidate scope `settings` (the
   * publisher only emits after commit). A fault anywhere in between rolls the whole
   * thing back and leaves a failure audit; nothing is ever half-applied.
   */
  private applyPolicies = async (params: {
    action: 'admin.settings.applyImmediate' | 'admin.settings.save';
    actorUserId: string;
    /** Success-audit detail, built from the revision this transaction commits. */
    auditAfterDiff: (committedRevision: number) => Record<string, unknown>;
    comment?: string;
    expectedDraftToken: string;
    expectedRevision: number;
    incoming: SettingsDraftPolicyMap;
    ownership: 'full' | 'policy-editor';
    reason: string;
  }): Promise<{ auditId: string; draftToken: string; revision: number }> => {
    await this.model.ensureBundle();

    let auditId: string | undefined;
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
            action: params.action,
            actorUserId: params.actorUserId,
            afterDiff: params.auditAfterDiff(committed.revision),
            beforeDiff: { revision: params.expectedRevision },
            configRevision: committed.revision,
            reason: params.reason,
            result: 'success',
            targetId: PLATFORM_SETTINGS_RESOURCE_ID,
            targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
          });
          auditId = audit.id;
        },
        invalidationScopes: ['settings'],
        // Replaced by prepareLockedPublish after the settings bundle lock.
        payload: {},
        pointer: this.settingsPointer({
          expectedDraftToken: params.expectedDraftToken,
          incoming: params.incoming,
          onDraftAligned: (token) => {
            committedDraftToken = token;
          },
          ownership: params.ownership,
          updatedBy: params.actorUserId,
        }),
        reason: params.reason,
        resourceId: PLATFORM_SETTINGS_RESOURCE_ID,
        resourceType: PLATFORM_SETTINGS_RESOURCE_TYPE,
      });
      revision = result.revision.revision;
      auditId ??= result.auditId;
    } catch (error) {
      await this.appendFailureAudit({
        action: params.action,
        actorUserId: params.actorUserId,
        beforeDiff: { expectedRevision: params.expectedRevision },
        error,
        reason: params.reason,
      });
      throw error;
    }

    // Both are set inside the committed transaction (`finalizeSuccess` / draft alignment),
    // so the response describes exactly this revision — no post-commit read that a
    // concurrent write could race, and no post-commit failure after a site-wide write landed.
    return { auditId: auditId!, draftToken: committedDraftToken!, revision };
  };

  /**
   * Bounded, secret-safe failure category for operational diagnosis.
   * Never includes raw exceptions, draft tokens, or setting values.
   */
  private publishFailureCategory = (error: unknown): string => {
    if (error instanceof PlatformRevisionConflictError) return 'revision_conflict';
    if (error instanceof SettingsDraftValidationError) return 'validation';
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
