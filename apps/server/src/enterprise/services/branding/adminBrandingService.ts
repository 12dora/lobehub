import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  checksumPayload,
  PlatformRevisionConflictError,
  PlatformRevisionModel,
  type ResourcePointerAdapter,
} from '@/database/models/platform';
import { files } from '@/database/schemas';
import {
  platformAuditLogs,
  platformBranding,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { PlatformBrandingItem } from '@/database/schemas/platform/branding';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import {
  type AdminBrandingDraft,
  adminBrandingDraftSchema,
  type AdminBrandingPublishInput,
  type AdminBrandingRollbackInput,
  type AdminBrandingSaveDraftInput,
  type AdminBrandingUploadAssetInput,
} from '../../contracts/adminBranding';
import { PlatformAuditService } from '../platformAudit';
import {
  getPlatformConfigInvalidationPublisher,
  type PlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';
import {
  type BrandingAssetStorage,
  FileBrandingAssetStorage,
  validateBrandingAsset,
} from './assetStorage';

export { BrandingAssetStorageUnavailableError, BrandingAssetValidationError } from './assetStorage';
export { PlatformRevisionConflictError };

export const BRANDING_RESOURCE_ID = 'global';
export const BRANDING_DRAFT_ROW_ID = 'branding:draft';
export const BRANDING_PUBLISHED_ROW_ID = 'branding:published';

const BRANDING_LOCK_NAMESPACE = 'aihub:platform-branding:global';
const BRANDING_ROW_IDS = [BRANDING_DRAFT_ROW_ID, BRANDING_PUBLISHED_ROW_ID] as const;

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
  const parsed = adminBrandingDraftSchema.parse(draft);
  if (!parsed.name) throw new BrandingDraftValidationError();
  if (parsed.pageTitleTemplate && !parsed.pageTitleTemplate.includes('%s')) {
    throw new BrandingDraftValidationError();
  }
  return parsed;
};

const draftAssetReferences = (draft: AdminBrandingDraft) => [
  { kind: 'desktopIcon', url: draft.desktop.iconUrl },
  { kind: 'favicon', url: draft.faviconUrl },
  { kind: 'icon', url: draft.iconUrl },
  { kind: 'logo', url: draft.logoUrl },
  { kind: 'ogImage', url: draft.ogImageUrl },
];

const assetIdFromUrl = (url: string): string | null =>
  /^\/f\/([\w-]{1,128})$/.exec(url)?.[1] ?? null;

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

class BrandingIdempotentPublish extends Error {
  constructor(
    readonly auditId: string,
    readonly revision: number,
  ) {
    super('BRANDING_IDEMPOTENT_PUBLISH');
  }
}

export interface AdminBrandingServiceOptions {
  assetReferenceLookup?: (
    db: LobeChatDatabase | Transaction,
    ids: string[],
  ) => Promise<{ fileType: string; id: string; metadata: Record<string, unknown> | null }[]>;
  assetStorage?: BrandingAssetStorage;
  invalidation?: PlatformConfigInvalidationPublisher;
}

export class AdminBrandingService {
  private readonly assetStorage: BrandingAssetStorage;
  private readonly db: LobeChatDatabase;
  private readonly invalidation: PlatformConfigInvalidationPublisher;
  private readonly assetReferenceLookup: NonNullable<
    AdminBrandingServiceOptions['assetReferenceLookup']
  >;
  private readonly revisions: PlatformRevisionModel;

  constructor(db: LobeChatDatabase, options: AdminBrandingServiceOptions = {}) {
    this.db = db;
    this.assetStorage = options.assetStorage ?? new FileBrandingAssetStorage(db);
    this.assetReferenceLookup =
      options.assetReferenceLookup ??
      (async (targetDb, ids) =>
        targetDb
          .select({ fileType: files.fileType, id: files.id, metadata: files.metadata })
          .from(files)
          .where(inArray(files.id, ids)) as Promise<
          { fileType: string; id: string; metadata: Record<string, unknown> | null }[]
        >);
    this.invalidation = options.invalidation ?? getPlatformConfigInvalidationPublisher();
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
  ): Promise<void> => {
    const references = draftAssetReferences(draft).filter(
      (reference): reference is { kind: string; url: string } => Boolean(reference.url),
    );
    if (references.length === 0) return;
    const ids = references.map(({ url }) => assetIdFromUrl(url));
    if (ids.some((id) => !id)) throw new BrandingDraftValidationError();
    const rows = await this.assetReferenceLookup(db, ids as string[]);
    for (const reference of references) {
      const id = assetIdFromUrl(reference.url);
      const row = rows.find((item) => item.id === id);
      const metadata = row?.metadata as Record<string, unknown> | null;
      if (
        !row ||
        metadata?.brandingAsset !== true ||
        metadata.kind !== reference.kind ||
        !['image/jpeg', 'image/png', 'image/webp', 'image/x-icon'].includes(row.fileType)
      ) {
        throw new BrandingDraftValidationError();
      }
    }
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
      storageConfigured: this.assetStorage.isConfigured(),
    };
  };

  saveDraft = async (actorUserId: string, input: AdminBrandingSaveDraftInput) => {
    const nextDraft = adminBrandingDraftSchema.parse(input.draft);
    await this.ensureDraft();
    try {
      const saved = await this.db.transaction(async (tx) => {
        await this.acquireLock(tx);
        const prior = await tx
          .select({
            afterDiff: platformAuditLogs.afterDiff,
            configRevision: platformAuditLogs.configRevision,
          })
          .from(platformAuditLogs)
          .where(
            and(
              eq(platformAuditLogs.action, 'admin.branding.saveDraft'),
              eq(platformAuditLogs.actorUserId, actorUserId),
              eq(platformAuditLogs.requestId, input.requestId),
              eq(platformAuditLogs.result, 'success'),
            ),
          )
          .limit(1);
        const priorToken = prior[0]?.afterDiff?.draftChecksum;
        if (typeof priorToken === 'string' && priorToken.length === 64) {
          return {
            baseRevision: prior[0].configRevision ?? 0,
            draftToken: priorToken,
            ok: true as const,
          };
        }
        await this.assertNoLegacyActiveRows(tx);
        const rows = await this.getFixedRows(tx);
        if (!rows.draft) throw new BrandingPersistenceInvariantError();
        const currentDraft = rowToDraft(rows.draft);
        if (draftToken(currentDraft, rows.draft.revision) !== input.expectedDraftToken) {
          throw new PlatformRevisionConflictError('Branding draft conflict');
        }
        await this.assertControlledAssets(tx, nextDraft);

        await tx
          .update(platformBranding)
          .set({ ...draftToColumns(nextDraft), updatedAt: new Date(), updatedBy: actorUserId })
          .where(eq(platformBranding.id, BRANDING_DRAFT_ROW_ID));
        const token = draftToken(nextDraft, rows.draft.revision);
        await new PlatformAuditService(tx).append({
          action: 'admin.branding.saveDraft',
          actorUserId,
          afterDiff: { ...summarizeDraft(nextDraft), draftChecksum: token },
          beforeDiff: summarizeDraft(currentDraft),
          configRevision: rows.draft.revision,
          reason: input.reason,
          requestId: input.requestId,
          result: 'success',
          targetId: BRANDING_RESOURCE_ID,
          targetType: 'branding',
        });
        return { baseRevision: rows.draft.revision, draftToken: token, ok: true as const };
      });
      return saved;
    } catch (error) {
      await this.appendFailureAudit('admin.branding.saveDraft', actorUserId, input);
      throw error;
    }
  };

  private publishPointer = (params: {
    actorUserId: string;
    expectedDraftToken: string;
    requestId: string;
  }): ResourcePointerAdapter => {
    let lockedDraft: AdminBrandingDraft | null = null;
    return {
      lockAndGetRevision: async (tx) => {
        await this.acquireLock(tx);
        const prior = await tx
          .select({ configRevision: platformAuditLogs.configRevision, id: platformAuditLogs.id })
          .from(platformAuditLogs)
          .where(
            and(
              eq(platformAuditLogs.action, 'platform.branding.publish'),
              eq(platformAuditLogs.actorUserId, params.actorUserId),
              eq(platformAuditLogs.requestId, params.requestId),
              eq(platformAuditLogs.result, 'success'),
            ),
          )
          .limit(1);
        if (prior[0]?.configRevision) {
          throw new BrandingIdempotentPublish(prior[0].id, prior[0].configRevision);
        }

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
        await tx
          .insert(platformBranding)
          .values({
            ...draftToColumns(draft),
            createdBy: params.actorUserId,
            id: BRANDING_PUBLISHED_ROW_ID,
            revision,
            status: 'published',
            updatedBy: params.actorUserId,
          })
          .onConflictDoUpdate({
            set: {
              ...draftToColumns(draft),
              revision,
              status: 'published',
              updatedAt: new Date(),
              updatedBy: params.actorUserId,
            },
            target: platformBranding.id,
          });
      },
      prepareLockedPublish: async (tx) => {
        if (!lockedDraft) throw new BrandingPersistenceInvariantError();
        const draft = validatePublishableDraft(lockedDraft);
        await this.assertControlledAssets(tx, draft);
        return { afterDiff: summarizeDraft(draft), payload: draft };
      },
      updatePointer: async (tx, { revision }) => {
        await tx
          .update(platformBranding)
          .set({ revision, status: 'draft', updatedAt: new Date(), updatedBy: params.actorUserId })
          .where(eq(platformBranding.id, BRANDING_DRAFT_ROW_ID));
      },
    };
  };

  publish = async (actorUserId: string, input: AdminBrandingPublishInput) => {
    await this.ensureDraft();
    try {
      const result = await this.revisions.publishDraft({
        actorUserId,
        beforeDiff: { revision: input.expectedRevision },
        comment: input.reason,
        expectedRevision: input.expectedRevision,
        payload: {},
        pointer: this.publishPointer({
          actorUserId,
          expectedDraftToken: input.expectedDraftToken,
          requestId: input.requestId,
        }),
        reason: input.reason,
        requestId: input.requestId,
        resourceId: BRANDING_RESOURCE_ID,
        resourceType: 'branding',
        sanitizePayload: (payload) => adminBrandingDraftSchema.parse(payload),
      });
      await this.publishInvalidation(result.revision.revision);
      return { auditId: result.auditId, revision: result.revision.revision };
    } catch (error) {
      if (error instanceof BrandingIdempotentPublish) {
        return { auditId: error.auditId, revision: error.revision };
      }
      await this.appendFailureAudit('platform.branding.publish', actorUserId, input);
      throw error;
    }
  };

  rollback = async (actorUserId: string, input: AdminBrandingRollbackInput) => {
    await this.ensureDraft();
    try {
      return await this.db.transaction(async (tx) => {
        await this.acquireLock(tx);
        const prior = await tx
          .select({
            afterDiff: platformAuditLogs.afterDiff,
            configRevision: platformAuditLogs.configRevision,
          })
          .from(platformAuditLogs)
          .where(
            and(
              eq(platformAuditLogs.action, 'admin.branding.rollback'),
              eq(platformAuditLogs.actorUserId, actorUserId),
              eq(platformAuditLogs.requestId, input.requestId),
              eq(platformAuditLogs.result, 'success'),
            ),
          )
          .limit(1);
        const priorTarget = prior[0]?.afterDiff?.restoredFromRevision;
        if (typeof priorTarget === 'number') {
          const priorRevision = await tx
            .select({ payload: platformResourceRevisions.payload })
            .from(platformResourceRevisions)
            .where(
              and(
                eq(platformResourceRevisions.resourceType, 'branding'),
                eq(platformResourceRevisions.resourceId, BRANDING_RESOURCE_ID),
                eq(platformResourceRevisions.revision, priorTarget),
              ),
            )
            .limit(1);
          if (priorRevision[0]) {
            const restoredDraft = adminBrandingDraftSchema.parse(priorRevision[0].payload);
            const restoredBaseRevision = prior[0].configRevision ?? input.expectedRevision;
            return {
              baseRevision: restoredBaseRevision,
              draft: restoredDraft,
              draftToken: draftToken(restoredDraft, restoredBaseRevision),
              restoredFromRevision: priorTarget,
            };
          }
        }
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
        await this.assertControlledAssets(tx, restored);
        const token = draftToken(restored, input.expectedRevision);
        await tx
          .update(platformBranding)
          .set({ ...draftToColumns(restored), updatedAt: new Date(), updatedBy: actorUserId })
          .where(eq(platformBranding.id, BRANDING_DRAFT_ROW_ID));
        await new PlatformAuditService(tx).append({
          action: 'admin.branding.rollback',
          actorUserId,
          afterDiff: { draftChecksum: token, restoredFromRevision: input.targetRevision },
          beforeDiff: { revision: input.expectedRevision },
          configRevision: input.expectedRevision,
          reason: input.reason,
          requestId: input.requestId,
          result: 'success',
          targetId: BRANDING_RESOURCE_ID,
          targetType: 'branding',
        });
        return {
          baseRevision: input.expectedRevision,
          draft: restored,
          draftToken: token,
          restoredFromRevision: input.targetRevision,
        };
      });
    } catch (error) {
      await this.appendFailureAudit('admin.branding.rollback', actorUserId, input);
      throw error;
    }
  };

  uploadAsset = async (actorUserId: string, input: AdminBrandingUploadAssetInput) => {
    try {
      const asset = await validateBrandingAsset(input);
      const stored = await this.assetStorage.upload({
        actorUserId,
        asset,
        fileName: input.fileName,
        kind: input.kind,
      });
      await new PlatformAuditService(this.db).append({
        action: 'admin.branding.uploadAsset',
        actorUserId,
        afterDiff: {
          bytes: asset.bytes.length,
          height: asset.height,
          kind: input.kind,
          mimeType: asset.mimeType,
          width: asset.width,
        },
        reason: input.reason,
        requestId: input.requestId,
        result: 'success',
        targetId: BRANDING_RESOURCE_ID,
        targetType: 'branding',
      });
      return {
        height: asset.height,
        mimeType: asset.mimeType,
        orphanPolicy: 'retained_until_sweep' as const,
        url: stored.url,
        width: asset.width,
      };
    } catch (error) {
      await this.appendFailureAudit('admin.branding.uploadAsset', actorUserId, input);
      throw error;
    }
  };

  private appendFailureAudit = async (
    action: string,
    actorUserId: string,
    input: { reason: string; requestId: string },
  ): Promise<void> => {
    try {
      await new PlatformAuditService(this.db).append({
        action,
        actorUserId,
        afterDiff: null,
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
