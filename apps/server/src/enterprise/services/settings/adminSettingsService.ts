/**
 * Admin settings draft / validate / publish / rollback (M05).
 *
 * Aggregate resource: resourceType=settings, resourceId=global.
 * Uses PlatformPublisherService for atomic revision + audit + invalidation.
 */

import {
  createSettingsPointerAdapter,
  PLATFORM_SETTINGS_BUNDLE_ID,
  PlatformSettingsModel,
  type SettingsDraftPolicyMap,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';
import {
  PLATFORM_SETTINGS_RESOURCE_ID,
  PLATFORM_SETTINGS_RESOURCE_TYPE,
  type SettingPolicyMode,
  type SettingPolicyVisibility,
  type SettingsValidationIssue,
} from '@/types/platform/settings';

import { PlatformAuditService } from '../platformAudit';
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
  private readonly model: PlatformSettingsModel;
  private readonly publisher: PlatformPublisherService;
  private readonly audit: PlatformAuditService;

  constructor(db: LobeChatDatabase) {
    this.model = new PlatformSettingsModel(db);
    this.publisher = new PlatformPublisherService(db);
    this.audit = new PlatformAuditService(db);
  }

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
    reason: string;
  }) => {
    const validation = await this.validateDraft(params.draft);
    if (!validation.ok) {
      await this.audit.append({
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

    const bundle = await this.model.saveDraft({
      draft: params.draft,
      updatedBy: params.actorUserId,
    });

    await this.audit.append({
      action: 'admin.settings.saveDraft',
      actorUserId: params.actorUserId,
      afterDiff: {
        pathCount: Object.keys(params.draft).length,
        // redacted: path modes only, no raw values
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

    return {
      baseRevision: bundle.revision,
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
      await this.audit.append({
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
        pointer: createSettingsPointerAdapter(PLATFORM_SETTINGS_BUNDLE_ID),
        reason: params.reason,
        resourceId: PLATFORM_SETTINGS_RESOURCE_ID,
        resourceType: PLATFORM_SETTINGS_RESOURCE_TYPE,
      });

      // Materialize published path policies for efficient resolver reads
      await this.model.replacePublishedPolicies({
        draft,
        revision: result.revision.revision,
        updatedBy: params.actorUserId,
      });

      return {
        auditId: result.auditId,
        revision: result.revision.revision,
      };
    } catch (error) {
      if (error instanceof PlatformRevisionConflictError) {
        await this.audit.append({
          action: 'admin.settings.publish',
          actorUserId: params.actorUserId,
          afterDiff: null,
          beforeDiff: { expectedRevision: params.expectedRevision },
          reason: params.reason,
          result: 'failure',
          targetId: PLATFORM_SETTINGS_RESOURCE_ID,
          targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
        });
      }
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
        pointer: createSettingsPointerAdapter(PLATFORM_SETTINGS_BUNDLE_ID),
        reason: params.reason,
        resourceId: PLATFORM_SETTINGS_RESOURCE_ID,
        resourceType: PLATFORM_SETTINGS_RESOURCE_TYPE,
        targetRevision: params.targetRevision,
      });

      // Restore published policies from the new head payload
      const snapshot = result.revision.payload as {
        policies?: SettingsDraftPolicyMap;
      } | null;
      const policies = snapshot?.policies ?? {};

      await this.model.replacePublishedPolicies({
        draft: policies,
        revision: result.revision.revision,
        updatedBy: params.actorUserId,
      });

      // Align draft with restored published snapshot
      await this.model.saveDraft({
        draft: policies,
        updatedBy: params.actorUserId,
      });

      return {
        auditId: result.auditId,
        revision: result.revision.revision,
      };
    } catch (error) {
      if (error instanceof PlatformRevisionConflictError) {
        await this.audit.append({
          action: 'admin.settings.rollback',
          actorUserId: params.actorUserId,
          afterDiff: null,
          beforeDiff: {
            expectedRevision: params.expectedRevision,
            targetRevision: params.targetRevision,
          },
          reason: params.reason,
          result: 'failure',
          targetId: PLATFORM_SETTINGS_RESOURCE_ID,
          targetType: PLATFORM_SETTINGS_RESOURCE_TYPE,
        });
      }
      throw error;
    }
  };
}
