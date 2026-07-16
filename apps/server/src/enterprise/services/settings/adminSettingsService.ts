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

import {
  type CreatePlatformAuditLogParams,
  type PlatformAuditLogItem,
  PlatformAuditService,
} from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { PlatformPublisherService, PlatformRevisionConflictError } from '../platformPublisher';
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

/** Production-empty lifecycle seam for causal transaction fault tests. */
export interface AdminSettingsMutationLifecycle {
  afterDraftLock?: () => Promise<void>;
  afterMaterialization?: (operation: 'publish' | 'rollback') => Promise<void>;
}

export interface AdminSettingsServiceOptions {
  auditAppend?: (
    db: LobeChatDatabase | Transaction,
    params: CreatePlatformAuditLogParams,
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
    operation: 'publish' | 'rollback';
    updatedBy?: string | null;
  }) =>
    createSettingsPointerAdapter({
      materializePublished: async (tx, args) => {
        const model = new PlatformSettingsModel(tx);
        const policies = ((args.payload as { policies?: SettingsDraftPolicyMap }).policies ??
          {}) as SettingsDraftPolicyMap;
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
  validateDraft = async (
    draft: SettingsDraftPolicyMap,
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
    const impactEstimate = await this.model.countOverridesByPaths(impactPaths);

    return { impactEstimate, issues, ok: issues.length === 0 };
  };

  saveDraft = async (params: {
    actorUserId: string;
    draft: SettingsDraftPolicyMap;
    expectedDraftToken: string;
    reason: string;
  }) => {
    const validation = await this.validateDraft(params.draft);
    if (!validation.ok) {
      // Best-effort failure audit after validation (no state write)
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
        const saved = await model.saveDraft({
          draft: params.draft,
          updatedBy: params.actorUserId,
        });
        await this.auditAppend(tx, {
          action: 'admin.settings.saveDraft',
          actorUserId: params.actorUserId,
          afterDiff: {
            pathCount: Object.keys(params.draft).length,
            paths: Object.fromEntries(
              Object.entries(params.draft).map(([path, p]) => [
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

  publish = async (params: {
    actorUserId: string;
    comment?: string;
    expectedRevision: number;
    reason: string;
  }) => {
    const bundle = await this.model.ensureBundle();
    const draft = (bundle.draft ?? {}) as SettingsDraftPolicyMap;

    const validation = await this.validateDraft(draft);
    if (!validation.ok) {
      await this.auditAppend(this.db, {
        action: 'admin.settings.publish',
        actorUserId: params.actorUserId,
        afterDiff: { issueCount: validation.issues.length },
        beforeDiff: { revision: bundle.revision },
        reason: params.reason,
        result: 'failure',
        targetId: PLATFORM_SETTINGS_RESOURCE_ID,
        targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
      });
      throw new SettingsDraftValidationError(validation.issues);
    }

    const payload = {
      policies: draft,
      registryVersion: settingsRegistry.version,
    };

    try {
      // Single transaction: revision + pointer + materialize policies + success audit;
      // invalidation only after commit (publisher already does this).
      const result = await this.publisher.publish({
        actorUserId: params.actorUserId,
        afterDiff: {
          pathCount: Object.keys(draft).length,
          paths: Object.fromEntries(
            Object.entries(draft).map(([path, p]) => [
              path,
              { mode: p.mode, visibility: p.visibility },
            ]),
          ),
        },
        beforeDiff: { revision: params.expectedRevision },
        comment: params.comment ?? params.reason,
        expectedRevision: params.expectedRevision,
        invalidationScopes: ['settings'],
        payload,
        pointer: this.settingsPointer({
          operation: 'publish',
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
        reason: params.reason,
      });
      throw error;
    }
  };

  rollback = async (params: {
    actorUserId: string;
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
        reason: params.reason,
      });
      throw error;
    }
  };

  /**
   * Failure audit runs only after the state transaction has rolled back. Audit
   * storage failure is deliberately non-recursive and never turns into success.
   */
  private appendFailureAudit = async (params: {
    action: string;
    actorUserId: string;
    beforeDiff: Record<string, unknown> | null;
    reason: string;
  }): Promise<void> => {
    try {
      await this.auditAppend(this.db, {
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: null,
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
