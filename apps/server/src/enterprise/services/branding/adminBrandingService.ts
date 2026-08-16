import { eq, inArray, sql } from 'drizzle-orm';

import {
  checksumPayload,
  PlatformRevisionConflictError,
  type ResourcePointerAdapter,
} from '@/database/models/platform';
import { platformBranding } from '@/database/schemas/platform';
import type {
  PlatformBrandingItem,
  PlatformBrandingOperationErrorCategory,
  PlatformBrandingOperationResult,
} from '@/database/schemas/platform/branding';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  type AdminBrandingGetOutput,
  type AdminBrandingPayload,
  adminBrandingPayloadSchema,
  type AdminBrandingSaveInput,
  adminBrandingSaveInputSchema,
  adminBrandingSaveOutputSchema,
  type AdminBrandingUploadAssetInput,
  adminBrandingUploadAssetInputSchema,
  adminBrandingUploadAssetOutputSchema,
  projectAdminBrandingPublished,
} from '../../contracts/adminBranding';
import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import { PlatformPublisherService } from '../platformPublisher';
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
export const BRANDING_MIRROR_ROW_ID = 'branding:draft';
export const BRANDING_PUBLISHED_ROW_ID = 'branding:published';

const BRANDING_LOCK_NAMESPACE = 'aihub:platform-branding:global';
const BRANDING_OPERATION_RESOURCE = 'branding:global';
const BRANDING_ROW_IDS = [BRANDING_MIRROR_ROW_ID, BRANDING_PUBLISHED_ROW_ID] as const;

const mutationFingerprint = <T extends { requestId: string }>(input: T): string => {
  const { requestId: _requestId, ...payload } = input;
  return checksumPayload(payload);
};

const emptyBranding = (): AdminBrandingPayload => ({
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

const rowToBranding = (row: PlatformBrandingItem): AdminBrandingPayload =>
  adminBrandingPayloadSchema.parse({
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

const brandingToColumns = (branding: AdminBrandingPayload) => ({
  defaultAgentDisplayName: branding.defaultAgentDisplayName,
  desktop: branding.desktop,
  displayName: branding.name,
  emailFrom: branding.emailFrom,
  emailSenderName: branding.emailSenderName,
  faviconUrl: branding.faviconUrl,
  homeUrl: branding.homeUrl,
  iconUrl: branding.iconUrl,
  legalName: branding.legalName,
  logoUrl: branding.logoUrl,
  ogImageUrl: branding.ogImageUrl,
  pageTitleTemplate: branding.pageTitleTemplate,
  privacyUrl: branding.privacyUrl,
  shortName: branding.shortName,
  supportUrl: branding.supportUrl,
  termsUrl: branding.termsUrl,
  themeDefaults: branding.themeDefaults,
});

const brandingToken = (branding: AdminBrandingPayload, revision: number): string =>
  checksumPayload({ branding, revision });

const summarizeBranding = (branding: AdminBrandingPayload) => ({
  configuredAssets: ['desktop.iconUrl', 'faviconUrl', 'iconUrl', 'logoUrl', 'ogImageUrl'].filter(
    (field) => {
      if (field === 'desktop.iconUrl') return Boolean(branding.desktop.iconUrl);
      return Boolean(branding[field as keyof AdminBrandingPayload]);
    },
  ),
  configuredFieldCount: Object.values(branding).filter((value) => value !== null).length,
  hasName: Boolean(branding.name),
});

const validatePublishableBranding = (branding: AdminBrandingPayload): AdminBrandingPayload => {
  const result = adminBrandingPayloadSchema.safeParse(branding);
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

interface BrandingSaveState {
  branding: AdminBrandingPayload;
  previous: AdminBrandingPayload;
  savedAt: Date;
}

export interface AdminBrandingServiceOptions {
  assetService?: AdminBrandingAssetService;
  assetServiceOptions?: AdminBrandingAssetServiceOptions;
  invalidation?: PlatformConfigInvalidationPublisher;
  operationService?: AdminBrandingOperationService;
}

export class AdminBrandingService {
  private readonly assets: AdminBrandingAssetService;
  private readonly db: LobeChatDatabase;
  private readonly operations: AdminBrandingOperationService;
  private readonly publisher: PlatformPublisherService;

  constructor(db: LobeChatDatabase, options: AdminBrandingServiceOptions = {}) {
    this.db = db;
    this.assets =
      options.assetService ?? new AdminBrandingAssetService(db, options.assetServiceOptions);
    this.operations = options.operationService ?? new AdminBrandingOperationService(db);
    this.publisher = new PlatformPublisherService(
      db,
      options.invalidation ?? getPlatformConfigInvalidationPublisher(),
    );
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

  /**
   * The `branding:draft` row is a mirror of the published row: it carries the revision pointer the
   * shared publish path updates and is never edited on its own.
   */
  private ensureMirrorRow = async (): Promise<void> => {
    await this.db.transaction(async (tx) => {
      await this.acquireLock(tx);
      await this.assertNoLegacyActiveRows(tx);
      const published = await tx
        .select()
        .from(platformBranding)
        .where(eq(platformBranding.id, BRANDING_PUBLISHED_ROW_ID))
        .limit(1);
      const seed = published[0] ? rowToBranding(published[0]) : emptyBranding();
      await tx
        .insert(platformBranding)
        .values({
          ...brandingToColumns(seed),
          id: BRANDING_MIRROR_ROW_ID,
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
      mirror: rows.find((row) => row.id === BRANDING_MIRROR_ROW_ID),
      published: rows.find((row) => row.id === BRANDING_PUBLISHED_ROW_ID),
    };
  };

  private assertControlledAssets = async (
    db: LobeChatDatabase | Transaction,
    branding: AdminBrandingPayload,
  ): Promise<string[]> => {
    try {
      return await this.assets.assertControlledReferences(db, branding);
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

  get = async (): Promise<AdminBrandingGetOutput> => {
    await this.ensureMirrorRow();
    await this.assertNoLegacyActiveRows(this.db);
    const rows = await this.getFixedRows(this.db);
    if (!rows.mirror || rows.mirror.status !== 'draft') {
      throw new BrandingPersistenceInvariantError();
    }
    if (rows.published && rows.published.status !== 'published') {
      throw new BrandingPersistenceInvariantError();
    }
    const branding = rows.published ? rowToBranding(rows.published) : emptyBranding();
    const revision = rows.published?.revision ?? 0;

    return {
      branding,
      revision,
      storageConfigured: this.assets.isStorageConfigured(),
      token: brandingToken(branding, revision),
      updatedAt: rows.published?.updatedAt?.toISOString() ?? null,
      updatedBy: rows.published?.updatedBy ?? null,
    };
  };

  private savePointer = (params: {
    actorUserId: string;
    branding: AdminBrandingPayload;
    expectedToken: string;
    fingerprint: string;
    onSaved: (state: BrandingSaveState) => void;
  }): ResourcePointerAdapter => {
    let previous: AdminBrandingPayload = emptyBranding();
    let prepared: AdminBrandingPayload | null = null;
    let preparedAssetIds: string[] = [];
    let savedAt = new Date();
    return {
      lockAndGetRevision: async (tx) => {
        await this.acquireLock(tx);
        await this.assertNoLegacyActiveRows(tx);
        const rows = await this.getFixedRows(tx);
        if (!rows.mirror) throw new BrandingPersistenceInvariantError();
        previous = rows.published ? rowToBranding(rows.published) : emptyBranding();
        const revision = rows.published?.revision ?? 0;
        if (brandingToken(previous, revision) !== params.expectedToken) {
          throw new PlatformRevisionConflictError('Branding revision conflict');
        }
        return revision;
      },
      materializePublished: async (tx, { payload, revision }) => {
        const branding = adminBrandingPayloadSchema.parse(payload);
        await tx
          .insert(platformBranding)
          .values({
            ...brandingToColumns(branding),
            createdBy: params.actorUserId,
            id: BRANDING_PUBLISHED_ROW_ID,
            revision,
            status: 'published',
            updatedAt: savedAt,
            updatedBy: params.actorUserId,
          })
          .onConflictDoUpdate({
            set: {
              ...brandingToColumns(branding),
              revision,
              status: 'published',
              updatedAt: savedAt,
              updatedBy: params.actorUserId,
            },
            target: platformBranding.id,
          });
        await this.assets.pinPublished(tx, preparedAssetIds, revision);
        params.onSaved({ branding, previous, savedAt });
      },
      prepareLockedPublish: async (tx, { currentRevision }) => {
        const validated = validatePublishableBranding(params.branding);
        const { revision: _publicRevision, ...publicFields } = projectAdminBrandingPublished(
          validated,
          currentRevision + 1,
        );
        const branding = adminBrandingPayloadSchema.parse({ ...validated, ...publicFields });
        preparedAssetIds = await this.assertControlledAssets(tx, branding);
        // Releases assets the previous payload referenced but never published, then re-pins
        // the ones this payload keeps; `pinPublished` stamps them right after.
        await this.assets.updateDraftPins(tx, preparedAssetIds);
        prepared = branding;
        savedAt = new Date();
        return {
          afterDiff: { ...summarizeBranding(branding), requestFingerprint: params.fingerprint },
          payload: branding,
        };
      },
      updatePointer: async (tx, { revision }) => {
        if (!prepared) throw new BrandingPersistenceInvariantError();
        await tx
          .update(platformBranding)
          .set({
            ...brandingToColumns(prepared),
            revision,
            status: 'draft',
            updatedAt: savedAt,
            updatedBy: params.actorUserId,
          })
          .where(eq(platformBranding.id, BRANDING_MIRROR_ROW_ID));
      },
    };
  };

  /**
   * The single de-drafted branding write: one transaction publishes the payload live, appends the
   * immutable revision head and mirrors the pointer row.
   */
  save = async (
    actorUserId: string,
    rawInput: AdminBrandingSaveInput,
  ): Promise<AdminBrandingGetOutput> => {
    const parsed = adminBrandingSaveInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new BrandingDraftValidationError();
    const input = parsed.data;
    const fingerprint = mutationFingerprint(input);
    const operation = await this.operations.claim({
      actorId: actorUserId,
      fingerprint,
      operation: 'admin.branding.save',
      requestId: input.requestId,
      resource: BRANDING_OPERATION_RESOURCE,
    });
    if (operation.state === 'pending') throw new BrandingOperationInProgressError();
    if (operation.state === 'failed') {
      throw new BrandingOperationFailedReplayError(operation.errorCategory);
    }
    if (operation.state === 'succeeded') {
      const { kind: _kind, ...result } = assertOperationKind(operation.result, 'save');
      return adminBrandingSaveOutputSchema.parse({
        ...result,
        storageConfigured: this.assets.isStorageConfigured(),
      });
    }
    const { claim } = operation;
    const saveState: { current: BrandingSaveState | null } = { current: null };
    /** The committed state is computed inside the publish transaction and returned verbatim. */
    const committed: { current: Omit<AdminBrandingGetOutput, 'storageConfigured'> | null } = {
      current: null,
    };
    try {
      await this.ensureMirrorRow();
      await this.publisher.publish({
        actorUserId,
        beforeDiff: { revision: input.expectedRevision },
        comment: input.reason,
        expectedRevision: input.expectedRevision,
        finalizeSuccess: async (tx, { revision }) => {
          const state = saveState.current;
          if (!state) throw new BrandingPersistenceInvariantError();
          const result = {
            branding: state.branding,
            revision,
            token: brandingToken(state.branding, revision),
            updatedAt: state.savedAt.toISOString(),
            updatedBy: actorUserId,
          };
          await new PlatformAuditService(tx).append({
            action: 'admin.branding.save',
            actorUserId,
            afterDiff: {
              ...summarizeBranding(result.branding),
              brandingChecksum: result.token,
              requestFingerprint: fingerprint,
            },
            beforeDiff: summarizeBranding(state.previous),
            configRevision: revision,
            reason: input.reason,
            requestId: input.requestId,
            result: 'success',
            targetId: BRANDING_RESOURCE_ID,
            targetType: 'branding',
          });
          await this.operations.succeed(tx, claim, { kind: 'save', ...result });
          committed.current = result;
        },
        invalidationScopes: ['branding'],
        payload: {},
        pointer: this.savePointer({
          actorUserId,
          branding: input.branding,
          expectedToken: input.expectedToken,
          fingerprint,
          onSaved: (state) => {
            saveState.current = state;
          },
        }),
        reason: input.reason,
        requestId: input.requestId,
        resourceId: BRANDING_RESOURCE_ID,
        resourceType: 'branding',
        sanitizePayload: (payload) => adminBrandingPayloadSchema.parse(payload),
      });
      if (!committed.current) throw new BrandingPersistenceInvariantError();
      return adminBrandingSaveOutputSchema.parse({
        ...committed.current,
        storageConfigured: this.assets.isStorageConfigured(),
      });
    } catch (error) {
      await this.recordOperationFailure(claim, error, 'admin.branding.save', actorUserId, input);
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
        // Bounded secret-safe category only — never raw exceptions or branding values.
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
}
