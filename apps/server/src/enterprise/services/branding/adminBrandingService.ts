import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  checksumPayload,
  PlatformRevisionConflictError,
  PlatformRevisionModel,
  type ResourcePointerAdapter,
} from '@/database/models/platform';
import { platformBranding, platformResourceRevisions } from '@/database/schemas/platform';
import type {
  PlatformBrandingItem,
  PlatformBrandingOperationErrorCategory,
  PlatformBrandingOperationResult,
} from '@/database/schemas/platform/branding';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  type AdminBrandingDraft,
  adminBrandingDraftSchema,
  type AdminBrandingPublishInput,
  adminBrandingPublishInputSchema,
  adminBrandingPublishOutputSchema,
  type AdminBrandingRollbackInput,
  adminBrandingRollbackInputSchema,
  adminBrandingRollbackOutputSchema,
  type AdminBrandingSaveDraftInput,
  adminBrandingSaveDraftInputSchema,
  adminBrandingSaveDraftOutputSchema,
  type AdminBrandingUploadAssetInput,
  adminBrandingUploadAssetInputSchema,
  adminBrandingUploadAssetOutputSchema,
  projectAdminBrandingPublished,
} from '../../contracts/adminBranding';
import { classifyEnterpriseError, observeEnterprisePlatformEvent } from '../../observability';
import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import {
  AdminBrandingAssetService,
  type AdminBrandingAssetServiceOptions,
  BrandingAssetCleanupClaimedError,
  BrandingAssetUploadInProgressError,
} from './adminBrandingAssetService';
import {
  AdminBrandingOperationService,
  BrandingIdempotencyConflictError,
  type BrandingOperationClaim,
  BrandingOperationFailedReplayError,
  BrandingOperationInProgressError,
  BrandingOperationRecoveryPendingError,
} from './adminBrandingOperationService';
import { BrandingAssetStorageUnavailableError, BrandingAssetValidationError } from './assetStorage';

export { BrandingAssetStorageUnavailableError, BrandingAssetValidationError } from './assetStorage';
export {
  BrandingAssetCleanupClaimedError,
  BrandingAssetUploadInProgressError,
  BrandingIdempotencyConflictError,
  BrandingOperationFailedReplayError,
  BrandingOperationInProgressError,
  BrandingOperationRecoveryPendingError,
};
export { PlatformRevisionConflictError };

export const BRANDING_RESOURCE_ID = 'global';
export const BRANDING_DRAFT_ROW_ID = 'branding:draft';
export const BRANDING_PUBLISHED_ROW_ID = 'branding:published';

const BRANDING_LOCK_NAMESPACE = 'aihub:platform-branding:global';
const BRANDING_OPERATION_RESOURCE = 'branding:global';
const BRANDING_ROW_IDS = [BRANDING_DRAFT_ROW_ID, BRANDING_PUBLISHED_ROW_ID] as const;

const mutationFingerprint = <T extends { requestId: string }>(input: T): string => {
  const { requestId: _requestId, ...payload } = input;
  return checksumPayload(payload);
};

const emptyDraft = (): AdminBrandingDraft => ({
  defaultAgentDisplayName: null,
  desktop: { iconUrl: null, productName: null },
  emailFrom: null,
  emailSenderName: null,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: null,
  logoUrl: null,
  name: null,
  ogImageUrl: null,
  pageTitleTemplate: null,
  privacyUrl: null,
  shortName: null,
  supportUrl: null,
  termsUrl: null,
  themeDefaults: { primaryColor: null },
});

const rowToDraft = (row: PlatformBrandingItem): AdminBrandingDraft =>
  adminBrandingDraftSchema.parse({
    defaultAgentDisplayName: row.defaultAgentDisplayName,
    desktop: row.desktop ?? {},
    emailFrom: row.emailFrom,
    emailSenderName: row.emailSenderName,
    faviconUrl: row.faviconUrl,
    homeUrl: row.homeUrl,
    iconUrl: row.iconUrl,
    legalName: row.legalName,
    logoUrl: row.logoUrl,
    name: row.displayName,
    ogImageUrl: row.ogImageUrl,
    pageTitleTemplate: row.pageTitleTemplate,
    privacyUrl: row.privacyUrl,
    shortName: row.shortName,
    supportUrl: row.supportUrl,
    termsUrl: row.termsUrl,
    themeDefaults: row.themeDefaults ?? {},
  });

const draftToColumns = (draft: AdminBrandingDraft) => ({
  defaultAgentDisplayName: draft.defaultAgentDisplayName,
  desktop: draft.desktop,
  displayName: draft.name,
  emailFrom: draft.emailFrom,
  emailSenderName: draft.emailSenderName,
  faviconUrl: draft.faviconUrl,
  homeUrl: draft.homeUrl,
  iconUrl: draft.iconUrl,
  legalName: draft.legalName,
  logoUrl: draft.logoUrl,
  ogImageUrl: draft.ogImageUrl,
  pageTitleTemplate: draft.pageTitleTemplate,
  privacyUrl: draft.privacyUrl,
  shortName: draft.shortName,
  supportUrl: draft.supportUrl,
  termsUrl: draft.termsUrl,
  themeDefaults: draft.themeDefaults,
});

const draftToken = (draft: AdminBrandingDraft, revision: number): string =>
  checksumPayload({ draft, revision });

const summarizeDraft = (draft: AdminBrandingDraft) => ({
  configuredAssets: ['desktop.iconUrl', 'faviconUrl', 'iconUrl', 'logoUrl', 'ogImageUrl'].filter(
    (field) => {
      if (field === 'desktop.iconUrl') return Boolean(draft.desktop.iconUrl);
      return Boolean(draft[field as keyof AdminBrandingDraft]);
    },
  ),
  configuredFieldCount: Object.values(draft).filter((value) => value !== null).length,
  hasName: Boolean(draft.name),
});

const validatePublishableDraft = (draft: AdminBrandingDraft): AdminBrandingDraft => {
  const result = adminBrandingDraftSchema.safeParse(draft);
  if (!result.success || !result.data.name) throw new BrandingDraftValidationError();
  const parsed = result.data;
  if (parsed.pageTitleTemplate && !parsed.pageTitleTemplate.includes('%s')) {
    throw new BrandingDraftValidationError();
  }
  try {
    projectAdminBrandingPublished(parsed, 1);
  } catch {
    throw new BrandingDraftValidationError();
  }
  return parsed;
};

export class BrandingDraftValidationError extends Error {
  constructor() {
    super('BRANDING_DRAFT_INVALID');
    this.name = 'BrandingDraftValidationError';
  }
}

export class BrandingPersistenceInvariantError extends Error {
  constructor() {
    super('BRANDING_PERSISTENCE_INVARIANT');
    this.name = 'BrandingPersistenceInvariantError';
  }
}

const operationErrorCategory = (error: unknown): PlatformBrandingOperationErrorCategory => {
  if (error instanceof PlatformRevisionConflictError) return 'revision_conflict';
  if (
    error instanceof BrandingDraftValidationError ||
    error instanceof BrandingAssetCleanupClaimedError
  ) {
    return 'draft_invalid';
  }
  if (error instanceof BrandingAssetValidationError) return 'asset_invalid';
  if (error instanceof BrandingAssetStorageUnavailableError) return 'asset_storage_unavailable';
  if (error instanceof BrandingAssetUploadInProgressError) return 'upload_in_progress';
  if (error instanceof BrandingPersistenceInvariantError) return 'persistence_invariant';
  return 'internal';
};

const assertOperationKind = <TKind extends PlatformBrandingOperationResult['kind']>(
  result: PlatformBrandingOperationResult,
  kind: TKind,
): Extract<PlatformBrandingOperationResult, { kind: TKind }> => {
  if (result.kind !== kind) throw new BrandingPersistenceInvariantError();
  return result as Extract<PlatformBrandingOperationResult, { kind: TKind }>;
};

export interface AdminBrandingServiceOptions {
  assetService?: AdminBrandingAssetService;
  assetServiceOptions?: AdminBrandingAssetServiceOptions;
  invalidation?: PlatformConfigInvalidationPublisher;
  operationService?: AdminBrandingOperationService;
}

export class AdminBrandingService {
  private readonly assets: AdminBrandingAssetService;
  private readonly db: LobeChatDatabase;
  private readonly invalidation: PlatformConfigInvalidationPublisher;
  private readonly operations: AdminBrandingOperationService;
  private readonly revisions: PlatformRevisionModel;

  constructor(db: LobeChatDatabase, options: AdminBrandingServiceOptions = {}) {
    this.db = db;
    this.assets =
      options.assetService ?? new AdminBrandingAssetService(db, options.assetServiceOptions);
    this.invalidation = options.invalidation ?? getPlatformConfigInvalidationPublisher();
    this.operations = options.operationService ?? new AdminBrandingOperationService(db);
    this.revisions = new PlatformRevisionModel(db);
  }

  private acquireLock = async (tx: Transaction): Promise<void> => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${BRANDING_LOCK_NAMESPACE})::bigint)`,
    );
  };

  private assertNoLegacyActiveRows = async (db: LobeChatDatabase | Transaction): Promise<void> => {
    const activeRows = await db
      .select({ id: platformBranding.id })
      .from(platformBranding)
      .where(inArray(platformBranding.status, ['draft', 'published']));
    if (
      activeRows.some(
        (row) => !BRANDING_ROW_IDS.includes(row.id as (typeof BRANDING_ROW_IDS)[number]),
      )
    ) {
      throw new BrandingPersistenceInvariantError();
    }
  };

  private ensureDraft = async (): Promise<void> => {
    await this.db.transaction(async (tx) => {
      await this.acquireLock(tx);
      await this.assertNoLegacyActiveRows(tx);
      const published = await tx
        .select()
        .from(platformBranding)
        .where(eq(platformBranding.id, BRANDING_PUBLISHED_ROW_ID))
        .limit(1);
      const seed = published[0] ? rowToDraft(published[0]) : emptyDraft();
      await tx
        .insert(platformBranding)
        .values({
          ...draftToColumns(seed),
          id: BRANDING_DRAFT_ROW_ID,
          revision: published[0]?.revision ?? 0,
          status: 'draft',
        })
        .onConflictDoNothing({ target: platformBranding.id });
    });
  };

  private getFixedRows = async (db: LobeChatDatabase | Transaction) => {
    const rows = await db
      .select()
      .from(platformBranding)
      .where(inArray(platformBranding.id, [...BRANDING_ROW_IDS]));
    return {
      draft: rows.find((row) => row.id === BRANDING_DRAFT_ROW_ID),
      published: rows.find((row) => row.id === BRANDING_PUBLISHED_ROW_ID),
    };
  };

  private assertControlledAssets = async (
    db: LobeChatDatabase | Transaction,
    draft: AdminBrandingDraft,
  ): Promise<string[]> => {
    try {
      return await this.assets.assertControlledReferences(db, draft);
    } catch {
      throw new BrandingDraftValidationError();
    }
  };

  private recordOperationFailure = async (
    claim: BrandingOperationClaim,
    error: unknown,
    action: AuditAction,
    actorUserId: string,
    input: { reason: string; requestId: string },
  ): Promise<void> => {
    const errorCategory = operationErrorCategory(error);
    await this.operations.fail(claim, errorCategory);
    await this.appendFailureAudit(action, actorUserId, input, errorCategory);
  };

  private observePublish = (startedAt: number, error?: unknown): void => {
    const conflict = error instanceof PlatformRevisionConflictError;
    observeEnterprisePlatformEvent({
      domain: 'branding',
      durationMs: Date.now() - startedAt,
      ...(error
        ? {
            errorClass: conflict ? ('ConflictError' as const) : classifyEnterpriseError(error),
          }
        : {}),
      operation: 'publish',
      outcome: error ? (conflict ? 'conflict' : 'failure') : 'success',
      type: 'config_publish',
    });
  };

  getDraft = async () => {
    await this.ensureDraft();
    await this.assertNoLegacyActiveRows(this.db);
    const rows = await this.getFixedRows(this.db);
    if (!rows.draft || rows.draft.status !== 'draft') throw new BrandingPersistenceInvariantError();
    if (rows.published && rows.published.status !== 'published') {
      throw new BrandingPersistenceInvariantError();
    }
    const draft = rowToDraft(rows.draft);
    const revisionRows = await this.revisions.listRevisions('branding', BRANDING_RESOURCE_ID, 50);

    return {
      baseRevision: rows.draft.revision,
      draft,
      draftMatchesPublished: rows.published
        ? checksumPayload(draft) === checksumPayload(rowToDraft(rows.published))
        : false,
      draftToken: draftToken(draft, rows.draft.revision),
      published: rows.published
        ? {
            ...rowToDraft(rows.published),
            name: rows.published.displayName!,
            revision: rows.published.revision,
          }
        : null,
      revisions: revisionRows.map((revision) => ({
        createdAt: revision.createdAt,
        createdBy: revision.createdBy,
        reason: revision.comment,
        revision: revision.revision,
      })),
      storageConfigured: this.assets.isStorageConfigured(),
    };
  };

  saveDraft = async (actorUserId: string, rawInput: AdminBrandingSaveDraftInput) => {
    const parsed = adminBrandingSaveDraftInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new BrandingDraftValidationError();
    const input = parsed.data;
    const nextDraft = input.draft;
    const fingerprint = mutationFingerprint(input);
    const operation = await this.operations.claim({
      actorId: actorUserId,
      fingerprint,
      operation: 'admin.branding.saveDraft',
      requestId: input.requestId,
      resource: BRANDING_OPERATION_RESOURCE,
    });
    if (operation.state === 'pending') throw new BrandingOperationInProgressError();
    if (operation.state === 'failed') {
      throw new BrandingOperationFailedReplayError(operation.errorCategory);
    }
    if (operation.state === 'succeeded') {
      const { kind: _kind, ...result } = assertOperationKind(operation.result, 'saveDraft');
      return adminBrandingSaveDraftOutputSchema.parse(result);
    }
    const { claim } = operation;
    try {
      await this.ensureDraft();
      const saved = await this.db.transaction(async (tx) => {
        await this.acquireLock(tx);
        await this.assertNoLegacyActiveRows(tx);
        const rows = await this.getFixedRows(tx);
        if (!rows.draft) throw new BrandingPersistenceInvariantError();
        const currentDraft = rowToDraft(rows.draft);
        if (draftToken(currentDraft, rows.draft.revision) !== input.expectedDraftToken) {
          throw new PlatformRevisionConflictError('Branding draft conflict');
        }
        const assetIds = await this.assertControlledAssets(tx, nextDraft);

        await tx
          .update(platformBranding)
          .set({ ...draftToColumns(nextDraft), updatedAt: new Date(), updatedBy: actorUserId })
          .where(eq(platformBranding.id, BRANDING_DRAFT_ROW_ID));
        await this.assets.updateDraftPins(tx, assetIds);
        const token = draftToken(nextDraft, rows.draft.revision);
        await new PlatformAuditService(tx).append({
          action: 'admin.branding.saveDraft',
          actorUserId,
          afterDiff: {
            ...summarizeDraft(nextDraft),
            draftChecksum: token,
            requestFingerprint: fingerprint,
          },
          beforeDiff: summarizeDraft(currentDraft),
          configRevision: rows.draft.revision,
          reason: input.reason,
          requestId: input.requestId,
          result: 'success',
          targetId: BRANDING_RESOURCE_ID,
          targetType: 'branding',
        });
        const result = { baseRevision: rows.draft.revision, draftToken: token, ok: true as const };
        await this.operations.succeed(tx, claim, { kind: 'saveDraft', ...result });
        return result;
      });
      return saved;
    } catch (error) {
      await this.recordOperationFailure(
        claim,
        error,
        'admin.branding.saveDraft',
        actorUserId,
        input,
      );
      throw error;
    }
  };

  private publishPointer = (params: {
    actorUserId: string;
    expectedDraftToken: string;
    fingerprint: string;
  }): ResourcePointerAdapter => {
    let lockedDraft: AdminBrandingDraft | null = null;
    let lockedAssetIds: string[] = [];
    return {
      lockAndGetRevision: async (tx) => {
        await this.acquireLock(tx);
        await this.assertNoLegacyActiveRows(tx);
        const rows = await this.getFixedRows(tx);
        if (!rows.draft) throw new BrandingPersistenceInvariantError();
        lockedDraft = rowToDraft(rows.draft);
        if (draftToken(lockedDraft, rows.draft.revision) !== params.expectedDraftToken) {
          throw new PlatformRevisionConflictError('Branding draft conflict');
        }
        return rows.draft.revision;
      },
      materializePublished: async (tx, { payload, revision }) => {
        const draft = validatePublishableDraft(adminBrandingDraftSchema.parse(payload));
        const { revision: _publicRevision, ...publicFields } = projectAdminBrandingPublished(
          draft,
          revision,
        );
        const normalizedDraft = adminBrandingDraftSchema.parse({ ...draft, ...publicFields });
        await tx
          .insert(platformBranding)
          .values({
            ...draftToColumns(normalizedDraft),
            createdBy: params.actorUserId,
            id: BRANDING_PUBLISHED_ROW_ID,
            revision,
            status: 'published',
            updatedBy: params.actorUserId,
          })
          .onConflictDoUpdate({
            set: {
              ...draftToColumns(normalizedDraft),
              revision,
              status: 'published',
              updatedAt: new Date(),
              updatedBy: params.actorUserId,
            },
            target: platformBranding.id,
          });
        await this.assets.pinPublished(tx, lockedAssetIds, revision);
      },
      prepareLockedPublish: async (tx) => {
        if (!lockedDraft) throw new BrandingPersistenceInvariantError();
        const draft = validatePublishableDraft(lockedDraft);
        lockedAssetIds = await this.assertControlledAssets(tx, draft);
        return {
          afterDiff: { ...summarizeDraft(draft), requestFingerprint: params.fingerprint },
          payload: draft,
        };
      },
      updatePointer: async (tx, { revision }) => {
        await tx
          .update(platformBranding)
          .set({ revision, status: 'draft', updatedAt: new Date(), updatedBy: params.actorUserId })
          .where(eq(platformBranding.id, BRANDING_DRAFT_ROW_ID));
      },
    };
  };

  publish = async (actorUserId: string, rawInput: AdminBrandingPublishInput) => {
    const startedAt = Date.now();
    const parsed = adminBrandingPublishInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new BrandingDraftValidationError();
    const input = parsed.data;
    const fingerprint = mutationFingerprint(input);
    const operation = await this.operations.claim({
      actorId: actorUserId,
      fingerprint,
      operation: 'admin.branding.publish',
      requestId: input.requestId,
      resource: BRANDING_OPERATION_RESOURCE,
    });
    if (operation.state === 'pending') throw new BrandingOperationInProgressError();
    if (operation.state === 'failed') {
      throw new BrandingOperationFailedReplayError(operation.errorCategory);
    }
    if (operation.state === 'succeeded') {
      const { kind: _kind, ...result } = assertOperationKind(operation.result, 'publish');
      return adminBrandingPublishOutputSchema.parse(result);
    }
    const { claim } = operation;
    try {
      await this.ensureDraft();
      const result = await this.revisions.publishDraft({
        actorUserId,
        beforeDiff: { revision: input.expectedRevision },
        comment: input.reason,
        expectedRevision: input.expectedRevision,
        finalizeSuccess: (tx, published) =>
          this.operations.succeed(tx, claim, { kind: 'publish', ...published }),
        payload: {},
        pointer: this.publishPointer({
          actorUserId,
          expectedDraftToken: input.expectedDraftToken,
          fingerprint,
        }),
        reason: input.reason,
        requestId: input.requestId,
        resourceId: BRANDING_RESOURCE_ID,
        resourceType: 'branding',
        sanitizePayload: (payload) => adminBrandingDraftSchema.parse(payload),
      });
      await this.publishInvalidation(result.revision.revision);
      this.observePublish(startedAt);
      return { auditId: result.auditId, revision: result.revision.revision };
    } catch (error) {
      try {
        await this.recordOperationFailure(
          claim,
          error,
          'admin.branding.publish',
          actorUserId,
          input,
        );
      } finally {
        this.observePublish(startedAt, error);
      }
      throw error;
    }
  };

  rollback = async (actorUserId: string, rawInput: AdminBrandingRollbackInput) => {
    const parsed = adminBrandingRollbackInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new BrandingDraftValidationError();
    const input = parsed.data;
    const fingerprint = mutationFingerprint(input);
    const operation = await this.operations.claim({
      actorId: actorUserId,
      fingerprint,
      operation: 'admin.branding.rollback',
      requestId: input.requestId,
      resource: BRANDING_OPERATION_RESOURCE,
    });
    if (operation.state === 'pending') throw new BrandingOperationInProgressError();
    if (operation.state === 'failed') {
      throw new BrandingOperationFailedReplayError(operation.errorCategory);
    }
    if (operation.state === 'succeeded') {
      const { kind: _kind, ...result } = assertOperationKind(operation.result, 'rollback');
      return adminBrandingRollbackOutputSchema.parse(result);
    }
    const { claim } = operation;
    try {
      await this.ensureDraft();
      return await this.db.transaction(async (tx) => {
        await this.acquireLock(tx);
        await this.assertNoLegacyActiveRows(tx);
        const rows = await this.getFixedRows(tx);
        if (!rows.draft) throw new BrandingPersistenceInvariantError();
        const currentDraft = rowToDraft(rows.draft);
        if (
          rows.draft.revision !== input.expectedRevision ||
          draftToken(currentDraft, rows.draft.revision) !== input.expectedDraftToken
        ) {
          throw new PlatformRevisionConflictError('Branding rollback conflict');
        }
        const targets = await tx
          .select()
          .from(platformResourceRevisions)
          .where(
            and(
              eq(platformResourceRevisions.resourceType, 'branding'),
              eq(platformResourceRevisions.resourceId, BRANDING_RESOURCE_ID),
              eq(platformResourceRevisions.revision, input.targetRevision),
            ),
          )
          .limit(1);
        if (!targets[0]) throw new BrandingDraftValidationError();
        const restored = validatePublishableDraft(
          adminBrandingDraftSchema.parse(targets[0].payload),
        );
        const assetIds = await this.assertControlledAssets(tx, restored);
        const token = draftToken(restored, input.expectedRevision);
        await tx
          .update(platformBranding)
          .set({ ...draftToColumns(restored), updatedAt: new Date(), updatedBy: actorUserId })
          .where(eq(platformBranding.id, BRANDING_DRAFT_ROW_ID));
        await this.assets.updateDraftPins(tx, assetIds);
        await new PlatformAuditService(tx).append({
          action: 'admin.branding.rollback',
          actorUserId,
          afterDiff: {
            draftChecksum: token,
            requestFingerprint: fingerprint,
            restoredFromRevision: input.targetRevision,
          },
          beforeDiff: { revision: input.expectedRevision },
          configRevision: input.expectedRevision,
          reason: input.reason,
          requestId: input.requestId,
          result: 'success',
          targetId: BRANDING_RESOURCE_ID,
          targetType: 'branding',
        });
        const result = {
          baseRevision: input.expectedRevision,
          draft: restored,
          draftToken: token,
          restoredFromRevision: input.targetRevision,
        };
        await this.operations.succeed(tx, claim, { kind: 'rollback', ...result });
        return result;
      });
    } catch (error) {
      await this.recordOperationFailure(
        claim,
        error,
        'admin.branding.rollback',
        actorUserId,
        input,
      );
      throw error;
    }
  };

  uploadAsset = async (actorUserId: string, rawInput: AdminBrandingUploadAssetInput) => {
    const parsed = adminBrandingUploadAssetInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new BrandingAssetValidationError();
    const input = parsed.data;
    const fingerprint = mutationFingerprint(input);
    const operation = await this.operations.claim({
      actorId: actorUserId,
      fingerprint,
      operation: 'admin.branding.uploadAsset',
      requestId: input.requestId,
      resource: BRANDING_OPERATION_RESOURCE,
    });
    if (operation.state === 'pending') throw new BrandingOperationInProgressError();
    if (operation.state === 'failed') {
      throw new BrandingOperationFailedReplayError(operation.errorCategory);
    }
    if (operation.state === 'succeeded') {
      const { kind: _kind, ...result } = assertOperationKind(operation.result, 'uploadAsset');
      return adminBrandingUploadAssetOutputSchema.parse(result);
    }
    const { claim } = operation;
    try {
      return await this.assets.upload(actorUserId, input, {
        finalizeSuccess: (tx, result) =>
          this.operations.succeed(tx, claim, { kind: 'uploadAsset', ...result }),
      });
    } catch (error) {
      await this.recordOperationFailure(
        claim,
        error,
        'admin.branding.uploadAsset',
        actorUserId,
        input,
      );
      throw error;
    }
  };

  private appendFailureAudit = async (
    action: AuditAction,
    actorUserId: string,
    input: { reason: string; requestId: string },
    errorCategory?: PlatformBrandingOperationErrorCategory,
  ): Promise<void> => {
    try {
      await new PlatformAuditService(this.db).append({
        action,
        actorUserId,
        // Bounded secret-safe category only — never raw exceptions or draft values.
        afterDiff: errorCategory ? { error: errorCategory } : null,
        beforeDiff: null,
        reason: input.reason,
        requestId: input.requestId,
        result: 'failure',
        targetId: BRANDING_RESOURCE_ID,
        targetType: 'branding',
      });
    } catch (auditError) {
      console.error('[admin.branding:auditFailure]', {
        action,
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
  };

  private publishInvalidation = async (revision: number): Promise<void> => {
    try {
      await this.invalidation.publish({
        at: new Date().toISOString(),
        resourceId: BRANDING_RESOURCE_ID,
        resourceType: 'branding',
        revision,
        scopes: ['branding'],
      });
    } catch (error) {
      console.error('[admin.branding:invalidationFailure]', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
        revision,
      });
    }
  };
}
