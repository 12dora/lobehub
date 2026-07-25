/**
 * Admin settings draft / validate / publish / rollback (M05).
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
  type SettingsValidationIssue,
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
import {
  isServiceModelManagedPath,
  mergePolicyEditorDraft,
  overlayCurrentForeignPolicies,
  preserveForeignPublishedInDraft,
} from './policyEditorOwnership';
import { settingsRegistry } from './registry';

export { PlatformRevisionConflictError };

export class SettingsDraftValidationError extends Error {
  readonly issues: SettingsValidationIssue[];
  constructor(issues: SettingsValidationIssue[]) {
    super('PLATFORM_CONFIG_VALIDATION_FAILED');
    this.name = 'SettingsDraftValidationError';
    this.issues = issues;
  }
}

/**
 * Draft has unpublished diffs on paths outside the applyImmediate patch.
 * Callers should direct admins to the Settings Policy page.
 */
export class SettingsDirtyDraftError extends Error {
  readonly dirtyPaths: string[];
  constructor(dirtyPaths: string[]) {
    super(
      'Unpublished settings draft differs outside the applied patch. Resolve on the Settings Policy page first.',
    );
    this.name = 'SettingsDirtyDraftError';
    this.dirtyPaths = dirtyPaths;
  }
}

const policyFingerprint = (policy: {
  mode: string;
  schemaVersion: number;
  value?: unknown;
  visibility: string;
}): string =>
  JSON.stringify({
    mode: policy.mode,
    schemaVersion: policy.schemaVersion,
    value: policy.value,
    visibility: policy.visibility,
  });

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
        await assertPublishedPlatformAiReferences(tx, bundle.draft);
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
          await model.saveDraft({
            draft: policies,
            updatedBy: params.updatedBy,
          });
        }
        await this.lifecycle.afterMaterialization?.(params.operation);
      },
      prepareLockedPublish: async (tx) => {
        const model = new PlatformSettingsModel(tx);
        const bundle = await model.getBundle();
        if (!bundle) throw new Error('Failed to load locked platform settings bundle');
        let draft = (bundle.draft ?? {}) as SettingsDraftPolicyMap;
        // Policy-editor only: re-attach foreign published paths absent from the draft so
        // empty/partial policy-editor drafts cannot wipe service-model policies.
        // Full ownership leaves the draft unchanged (intentional foreign deletes stick).
        if (params.ownership === 'policy-editor') {
          const published = await model.listPublishedPolicies();
          draft = preserveForeignPublishedInDraft(draft, published);
        }
        const validation = await this.validateDraftWithModel(draft, model);
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
   * Validate entire draft bundle. Fail-closed on unknown/secret/wrong-type paths.
   */
  private validateDraftWithModel = async (
    draft: SettingsDraftPolicyMap,
    model: PlatformSettingsModel,
  ): Promise<{
    impactEstimate: { pathsWithOverrides: number; totalOverrideRows: number };
    issues: SettingsValidationIssue[];
    ok: boolean;
  }> => {
    const issues: SettingsValidationIssue[] = [];

    for (const [path, policy] of Object.entries(draft)) {
      const gate = settingsRegistry.assertPathWritable({
        path,
        requirePlatformEligible: true,
      });
      if (gate) {
        issues.push({ code: gate, message: gate, path });
        continue;
      }

      if (!['user', 'default', 'locked'].includes(policy.mode)) {
        issues.push({
          code: 'MANAGED_SETTING_INVALID_VALUE',
          message: `Invalid mode: ${String(policy.mode)}`,
          path,
        });
      }
      if (!['visible', 'hidden'].includes(policy.visibility)) {
        issues.push({
          code: 'MANAGED_SETTING_INVALID_VALUE',
          message: `Invalid visibility: ${String(policy.visibility)}`,
          path,
        });
      }

      // mode=user may omit meaningful platform value; default/locked require valid value
      if (policy.mode === 'default' || policy.mode === 'locked') {
        const validated = settingsRegistry.validateValue(path, policy.value);
        if (!validated.ok) {
          issues.push({
            code: 'MANAGED_SETTING_INVALID_VALUE',
            message: validated.message,
            path,
          });
        }
      } else if (policy.value !== null && policy.value !== undefined) {
        const validated = settingsRegistry.validateValue(path, policy.value);
        if (!validated.ok) {
          issues.push({
            code: 'MANAGED_SETTING_INVALID_VALUE',
            message: validated.message,
            path,
          });
        }
      }

      const entry = settingsRegistry.get(path);
      if (entry && policy.schemaVersion !== entry.schemaVersion) {
        issues.push({
          code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
          message: `Schema version mismatch: expected ${entry.schemaVersion}, got ${policy.schemaVersion}`,
          path,
        });
      }
    }

    const impactPaths = Object.entries(draft)
      .filter(([, p]) => p.mode === 'locked' || p.mode === 'default')
      .map(([path]) => path);
    const impactEstimate = await model.countOverridesByPaths(impactPaths);

    return { impactEstimate, issues, ok: issues.length === 0 };
  };

  validateDraft = async (draft: SettingsDraftPolicyMap) =>
    this.validateDraftWithModel(draft, this.model);

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
          const validation = await this.validateDraftWithModel(nextDraft, model);
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
   * Merge path→value patch into draft and publish immediately (W10-C).
   *
   * Mode rules (basis = **published** policy, not draft):
   * - published mode === 'locked' → stay 'locked'
   * - published mode === 'user' / missing → 'default'
   * - published mode === 'default' → stay 'default'
   * Visibility comes from published (fallback draft/visible). schemaVersion from registry.
   *
   * Rejects when draft differs from published on any path outside the patch.
   *
   * On publish failure, restore uses `saved.draftToken` (not a fresh getDraft token)
   * so concurrent drafts are not overwritten; token mismatch abandons restore.
   */
  applyImmediate = async (params: {
    actorUserId: string;
    patch: Record<string, unknown>;
    reason?: string;
  }) => {
    const patchPaths = Object.keys(params.patch);
    if (patchPaths.length === 0) {
      throw new SettingsDraftValidationError([
        {
          code: 'MANAGED_SETTING_INVALID_VALUE',
          message: 'patch must include at least one path',
          path: '',
        },
      ]);
    }

    const sortedPaths = [...patchPaths].sort();
    const reason =
      params.reason?.trim() ||
      `applyImmediate: ${sortedPaths.slice(0, 12).join(', ')}${sortedPaths.length > 12 ? ` (+${sortedPaths.length - 12})` : ''}`;

    const snapshot = await this.getDraft();
    const draft = { ...snapshot.draft } as SettingsDraftPolicyMap;
    const published = { ...snapshot.publishedPolicies } as SettingsDraftPolicyMap;
    const patchSet = new Set(patchPaths);

    // Dirty-draft gate: non-patch paths must match published.
    const dirtyPaths: string[] = [];
    for (const path of new Set([...Object.keys(draft), ...Object.keys(published)])) {
      if (patchSet.has(path)) continue;
      const d = draft[path];
      const p = published[path];
      if (!d && !p) continue;
      if (!d || !p || policyFingerprint(d) !== policyFingerprint(p)) {
        dirtyPaths.push(path);
      }
    }
    if (dirtyPaths.length > 0) {
      await this.auditAppend(this.db, {
        action: 'admin.settings.applyImmediate',
        actorUserId: params.actorUserId,
        afterDiff: { dirtyPathCount: dirtyPaths.length },
        beforeDiff: null,
        reason,
        result: 'failure',
        targetId: PLATFORM_SETTINGS_RESOURCE_ID,
        targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
      });
      throw new SettingsDirtyDraftError(dirtyPaths.sort());
    }

    // Start from draft (equals published outside patch when clean). Ensure published
    // paths remain present so publish does not wipe non-patched policies.
    const nextDraft: SettingsDraftPolicyMap = { ...published, ...draft };

    for (const path of patchPaths) {
      const gate = settingsRegistry.assertPathWritable({
        path,
        requirePlatformEligible: true,
      });
      if (gate) {
        throw new SettingsDraftValidationError([{ code: gate, message: gate, path }]);
      }

      const entry = settingsRegistry.get(path);
      if (!entry) {
        throw new SettingsDraftValidationError([
          { code: 'MANAGED_SETTING_UNKNOWN_PATH', message: 'Unknown path', path },
        ]);
      }

      const validated = settingsRegistry.validateValue(path, params.patch[path]);
      if (!validated.ok) {
        throw new SettingsDraftValidationError([
          {
            code: 'MANAGED_SETTING_INVALID_VALUE',
            message: validated.message,
            path,
          },
        ]);
      }

      // Mode / visibility basis = published policy (ignore unpublished draft mode edits).
      const publishedPolicy = published[path];
      const draftPolicy = draft[path];
      const nextMode: SettingPolicyMode = publishedPolicy?.mode === 'locked' ? 'locked' : 'default';
      const nextVisibility = (publishedPolicy?.visibility ??
        draftPolicy?.visibility ??
        'visible') as SettingPolicyVisibility;

      nextDraft[path] = {
        mode: nextMode,
        schemaVersion: entry.schemaVersion,
        value: validated.value,
        visibility: nextVisibility,
      };
    }

    const priorDraft = { ...draft } as SettingsDraftPolicyMap;

    const saved = await this.saveDraft({
      actorUserId: params.actorUserId,
      draft: nextDraft,
      expectedDraftToken: snapshot.draftToken,
      reason,
    });

    let publishedResult: { auditId: string; revision: number };
    try {
      publishedResult = await this.publish({
        actorUserId: params.actorUserId,
        expectedDraftToken: saved.draftToken,
        expectedRevision: saved.baseRevision,
        reason,
      });
    } catch (error) {
      // Best-effort restore: pin expectedDraftToken to *our* saveDraft result so a
      // concurrent admin who saved during the publish-failure window is not overwritten.
      try {
        await this.saveDraft({
          actorUserId: params.actorUserId,
          draft: priorDraft,
          expectedDraftToken: saved.draftToken,
          reason: `${reason} (restore after publish failure)`,
        });
      } catch (restoreError) {
        const abandoned =
          restoreError instanceof PlatformRevisionConflictError
            ? 'concurrent_draft_write'
            : 'restore_failed';
        try {
          await this.auditAppend(this.db, {
            action: 'admin.settings.applyImmediate',
            actorUserId: params.actorUserId,
            afterDiff: { abandonedRestore: abandoned },
            beforeDiff: null,
            reason: `${reason} (restore abandoned: ${abandoned})`,
            result: 'failure',
            targetId: PLATFORM_SETTINGS_RESOURCE_ID,
            targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
          });
        } catch {
          /* best-effort */
        }
      }
      throw error;
    }

    // Dedicated success audit for the combined applyImmediate operation.
    let applyAuditId = publishedResult.auditId;
    try {
      const audit = await this.auditAppend(this.db, {
        action: 'admin.settings.applyImmediate',
        actorUserId: params.actorUserId,
        afterDiff: {
          pathCount: sortedPaths.length,
          paths: Object.fromEntries(
            sortedPaths.map((path) => [
              path,
              {
                mode: nextDraft[path]?.mode,
                visibility: nextDraft[path]?.visibility,
              },
            ]),
          ),
          revision: publishedResult.revision,
        },
        beforeDiff: { revision: snapshot.baseRevision },
        reason,
        result: 'success',
        targetId: PLATFORM_SETTINGS_RESOURCE_ID,
        targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
      });
      applyAuditId = audit.id;
    } catch {
      /* best-effort; publish already audited */
    }

    const after = await this.getDraft();
    return {
      auditId: applyAuditId,
      draftToken: after.draftToken,
      paths: sortedPaths,
      revision: publishedResult.revision,
    };
  };

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
