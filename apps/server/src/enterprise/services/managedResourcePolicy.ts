import {
  checksumPayload,
  createManagedResourcePolicyPointerAdapter,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  ManagedResourcePolicyItem,
  ManagedResourcePolicyMap,
  ManagedResourceReadinessMap,
} from '@/types/platform/managedResources';
import {
  MANAGED_POLICY_RESOURCE_ID,
  MANAGED_POLICY_RESOURCE_TYPE,
} from '@/types/platform/managedResources';

import { resetPlatformAiTakeoverCache } from './aiCatalog/enforcement';
import type { AuditAction } from './audit/auditActionCatalog';
import { resolveManagedResourceReadiness } from './managedResourceReadiness';
import {
  type AppendPlatformAuditLogParams,
  type PlatformAuditLogItem,
  PlatformAuditService,
} from './platformAudit';
import type { PlatformConfigInvalidationPublisher } from './platformConfigInvalidation';
import { PlatformPublisherService, PlatformRevisionConflictError } from './platformPublisher';

export { PlatformRevisionConflictError };

export class ManagedResourceCatalogNotReadyError extends Error {
  readonly resources: string[];

  constructor(resources: string[]) {
    super('PLATFORM_CONFIG_VALIDATION_FAILED');
    this.name = 'ManagedResourceCatalogNotReadyError';
    this.resources = resources;
  }
}

export interface ManagedResourcePolicyServiceOptions {
  auditAppend?: (
    db: LobeChatDatabase | Transaction,
    params: AppendPlatformAuditLogParams,
  ) => Promise<PlatformAuditLogItem>;
  invalidation?: PlatformConfigInvalidationPublisher;
  lifecycle?: {
    afterMaterialization?: () => Promise<void>;
    afterPublishLock?: () => Promise<void>;
  };
  readiness?: () => Promise<ManagedResourceReadinessMap>;
}

export class ManagedResourcePolicyService {
  private readonly auditAppend: NonNullable<ManagedResourcePolicyServiceOptions['auditAppend']>;
  private readonly db: LobeChatDatabase;
  private readonly model: PlatformManagedResourcePolicyModel;
  private readonly publisher: PlatformPublisherService;
  private readonly readiness: NonNullable<ManagedResourcePolicyServiceOptions['readiness']>;
  private readonly lifecycle: NonNullable<ManagedResourcePolicyServiceOptions['lifecycle']>;

  constructor(db: LobeChatDatabase, options: ManagedResourcePolicyServiceOptions = {}) {
    this.db = db;
    this.model = new PlatformManagedResourcePolicyModel(db);
    this.publisher = new PlatformPublisherService(db, options.invalidation);
    this.lifecycle = options.lifecycle ?? {};
    this.auditAppend =
      options.auditAppend ??
      ((auditDb, params) => new PlatformAuditService(auditDb).append(params));
    this.readiness = options.readiness ?? resolveManagedResourceReadiness;
  }

  private draftToken = (draft: ManagedResourcePolicyMap, revision: number): string =>
    checksumPayload({ draft, revision });

  get = async () => {
    await this.model.ensureRows();
    const [snapshot, readiness] = await Promise.all([this.model.getSnapshot(), this.readiness()]);
    return {
      baseRevision: snapshot.revision,
      draft: snapshot.draft,
      draftToken: this.draftToken(snapshot.draft, snapshot.revision),
      published: snapshot.published,
      readiness,
      status: snapshot.status,
    };
  };

  /**
   * De-drafted 统一管理 write: persist the incoming policy map **and** publish it in ONE
   * transaction. Collapses the former `saveDraft` + `publish` pair.
   *
   * Order preserved from the old two-step flow (the caller begins/finalizes the connector
   * runtime transition around this call, see `routers/admin/managedResources.ts`):
   * CAS on the locked draft token → readiness gate (`ManagedResourceCatalogNotReadyError`)
   * → revision + materialize (draft and published columns are written together) → audit →
   * COMMIT → invalidate `['managed-policy','capabilities']` → drop the in-process
   * platform-AI takeover memo.
   */
  save = async (params: {
    actorUserId: string;
    comment?: string;
    draft: ManagedResourcePolicyMap;
    expectedDraftToken: string;
    expectedRevision: number;
    reason: string;
  }) => {
    await this.model.ensureRows();

    let previousPublished: ManagedResourcePolicyMap | null = null;
    let saveAuditId: string | undefined;

    const pointer = createManagedResourcePolicyPointerAdapter({
      afterMaterialization: this.lifecycle.afterMaterialization,
      assertLockedState: async (tx) => {
        await this.lifecycle.afterPublishLock?.();
        const model = new PlatformManagedResourcePolicyModel(tx);
        const snapshot = await model.getSnapshot();
        if (this.draftToken(snapshot.draft, snapshot.revision) !== params.expectedDraftToken) {
          throw new PlatformRevisionConflictError(
            'Managed resource policy draft token does not match locked draft',
          );
        }
        previousPublished = snapshot.published;
      },
      prepareLockedPublish: async () => {
        const readiness = await this.readiness();
        const notReady = Object.entries(params.draft)
          .filter(([resource, rawItem]) => {
            const item = rawItem as ManagedResourcePolicyItem;
            return (
              item.managed &&
              item.enforcementMode === 'enforced' &&
              !readiness[resource as keyof ManagedResourceReadinessMap]
            );
          })
          .map(([resource]) => resource);
        if (notReady.length > 0) throw new ManagedResourceCatalogNotReadyError(notReady);
        return {
          afterDiff: { policies: params.draft, readiness },
          payload: { policies: params.draft },
        };
      },
      updatedBy: params.actorUserId,
    });

    try {
      const result = await this.publisher.publish({
        actorUserId: params.actorUserId,
        beforeDiff: { revision: params.expectedRevision },
        comment: params.comment ?? params.reason,
        expectedRevision: params.expectedRevision,
        // Admin-facing audit committed atomically with the revision it describes.
        finalizeSuccess: async (tx, committed) => {
          const audit = await this.auditAppend(tx, {
            action: 'admin.managedResources.save',
            actorUserId: params.actorUserId,
            afterDiff: { policies: params.draft },
            beforeDiff: { policies: previousPublished },
            configRevision: committed.revision,
            reason: params.reason,
            result: 'success',
            targetId: MANAGED_POLICY_RESOURCE_ID,
            targetType: MANAGED_POLICY_RESOURCE_TYPE,
          });
          saveAuditId = audit.id;
        },
        invalidationScopes: ['managed-policy', 'capabilities'],
        payload: {},
        pointer,
        reason: params.reason,
        resourceId: MANAGED_POLICY_RESOURCE_ID,
        resourceType: MANAGED_POLICY_RESOURCE_TYPE,
      });
      // AFTER commit (never in afterMaterialization, which runs inside the transaction): drop
      // the in-process platform-AI takeover memo so the next runtime/router read on THIS
      // instance already sees the policy that was just published. Other instances converge
      // within the memo TTL — the platform invalidation channel is a pull-based Redis version
      // bump with no subscriber, so there is no push hook to ride.
      resetPlatformAiTakeoverCache();
      return { auditId: saveAuditId ?? result.auditId, revision: result.revision.revision };
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.managedResources.save',
        actorUserId: params.actorUserId,
        reason: params.reason,
      });
      throw error;
    }
  };

  private appendFailureAudit = async (params: {
    action: AuditAction;
    actorUserId: string;
    reason: string;
  }): Promise<void> => {
    try {
      await this.auditAppend(this.db, {
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: { error: 'operation_failed' },
        beforeDiff: null,
        reason: params.reason,
        result: 'failure',
        targetId: MANAGED_POLICY_RESOURCE_ID,
        targetType: MANAGED_POLICY_RESOURCE_TYPE,
      });
    } catch (auditError) {
      console.error('[admin.managedResources] failure audit append failed', auditError);
    }
  };
}
