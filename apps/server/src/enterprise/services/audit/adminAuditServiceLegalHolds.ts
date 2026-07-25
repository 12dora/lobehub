/**
 * Legal-hold mutations and reads for AdminAuditService (SAO-009).
 */

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import {
  LegalHoldPurgeInProgressError,
  PlatformAuditLegalHoldModel,
} from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import type {
  AdminAuditLegalHoldsCreateInput,
  AdminAuditLegalHoldsListInputParsed,
  AdminAuditLegalHoldsReleaseInput,
} from '../../contracts/adminAudit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { appendAuditAccessLog, buildAuditFilterSummary } from './accessLog';
import type { AdminAuditServiceHost } from './adminAuditServiceHost';
import { isNotFoundError, toLegalHoldPublic } from './adminAuditServiceShared';

export const listLegalHolds = async (
  host: AdminAuditServiceHost,
  params: {
    actorUserId: string;
    input: AdminAuditLegalHoldsListInputParsed;
  },
) => {
  const filterSummary = buildAuditFilterSummary({
    cursor: params.input.cursor,
    limit: params.input.limit,
    scopeType: params.input.scopeType,
  });
  try {
    const page = await host.legalHoldModel.list({
      createdBy: params.input.createdBy,
      cursor: params.input.cursor,
      limit: params.input.limit,
      scopeId: params.input.scopeId,
      scopeType: params.input.scopeType,
      status: params.input.status,
    });
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.legalHolds.list',
      actorUserId: params.actorUserId,
      filterSummary,
      result: 'success',
      targetType: 'legal_hold',
    });
    return {
      // Explicit row callback — map would pass index as the second arg (`now`).
      items: page.items.map((row) => toLegalHoldPublic(row)),
      nextCursor: page.nextCursor,
    };
  } catch (error) {
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.legalHolds.list',
      actorUserId: params.actorUserId,
      afterDiff: { error: 'failure' },
      filterSummary,
      result: 'failure',
      targetType: 'legal_hold',
    });
    throw error;
  }
};

export const getLegalHold = async (
  host: AdminAuditServiceHost,
  params: { actorUserId: string; id: string },
) => {
  const filterSummary = buildAuditFilterSummary({});
  try {
    const row = await host.legalHoldModel.get(params.id);
    if (!row) {
      await appendAuditAccessLog(host.db, {
        action: 'admin.audit.legalHolds.get',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'not_found' },
        filterSummary,
        result: 'failure',
        targetId: params.id,
        targetType: 'legal_hold',
      });
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
        httpCode: 'NOT_FOUND',
      });
    }
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.legalHolds.get',
      actorUserId: params.actorUserId,
      filterSummary,
      result: 'success',
      targetId: params.id,
      targetType: 'legal_hold',
    });
    return toLegalHoldPublic(row);
  } catch (error) {
    if (isNotFoundError(error)) throw error;
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.legalHolds.get',
      actorUserId: params.actorUserId,
      afterDiff: { error: 'failure' },
      filterSummary,
      result: 'failure',
      targetId: params.id,
      targetType: 'legal_hold',
    });
    throw error;
  }
};

export const createLegalHold = async (
  host: AdminAuditServiceHost,
  params: {
    actorUserId: string;
    input: AdminAuditLegalHoldsCreateInput;
  },
) => {
  const filterSummary = buildAuditFilterSummary({
    scopeType: params.input.scopeType,
  });
  try {
    // Reject non-future expiry so the UI cannot show "active" holds that
    // retention's listActive() already treats as expired.
    if (params.input.expiresAt != null) {
      const expiresMs = params.input.expiresAt.getTime();
      if (Number.isNaN(expiresMs) || expiresMs <= Date.now()) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
          details: { reason: 'expires_at_must_be_future' },
          httpCode: 'BAD_REQUEST',
          // Stable code as message — clients localize via details.reason / code.
          message: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        });
      }
    }

    const db = host.db as LobeChatDatabase;
    // Optional HEAD probe so stranded deleting outboxes self-heal before create.
    // Failures other than not-found rethrow so reconcile does not finalize blindly.
    const objectExists = async (storageKey: string): Promise<boolean> => {
      const { AuditExportPrivateS3Storage } = await import('./exportStorage');
      let storage: InstanceType<typeof AuditExportPrivateS3Storage>;
      try {
        storage = new AuditExportPrivateS3Storage();
      } catch {
        // Storage not configured — skip self-heal (reconcile treats throw as skip).
        throw new Error('AUDIT_EXPORT_STORAGE_UNAVAILABLE');
      }
      try {
        await storage.getObjectMetadata(storageKey);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not found|NoSuchKey|NotFound|404|NoSuchBucket/i.test(msg)) return false;
        throw err;
      }
    };
    const row = await db.transaction(async (tx) => {
      const legalHoldModel = new PlatformAuditLegalHoldModel(tx);
      const created = await legalHoldModel.create({
        createdBy: params.actorUserId,
        expiresAt: params.input.expiresAt,
        objectExists,
        reason: params.input.reason,
        scopeId: params.input.scopeId,
        scopeType: params.input.scopeType,
      });
      await appendAuditAccessLog(tx, {
        action: 'admin.audit.legalHolds.create',
        actorUserId: params.actorUserId,
        afterDiff: {
          scopeIdPresent: params.input.scopeId != null,
          scopeType: created.scopeType,
          status: created.status,
        },
        filterSummary,
        reason: params.input.reason,
        required: true,
        result: 'success',
        targetId: created.id,
        targetType: 'legal_hold',
      });
      return created;
    });
    return toLegalHoldPublic(row);
  } catch (error) {
    if (
      error instanceof LegalHoldPurgeInProgressError ||
      (error instanceof Error && error.message === 'LEGAL_HOLD_PURGE_IN_PROGRESS')
    ) {
      await appendAuditAccessLog(host.db, {
        action: 'admin.audit.legalHolds.create',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'purge_in_progress' },
        filterSummary,
        reason: params.input.reason,
        result: 'failure',
        targetType: 'legal_hold',
      });
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_RESOURCE_IN_USE,
        details: { reason: 'purge_in_progress' },
        httpCode: 'CONFLICT',
        message: PLATFORM_ERROR_CODES.PLATFORM_RESOURCE_IN_USE,
      });
    }
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.legalHolds.create',
      actorUserId: params.actorUserId,
      afterDiff: { error: 'failure' },
      filterSummary,
      reason: params.input.reason,
      result: 'failure',
      targetType: 'legal_hold',
    });
    throw error;
  }
};

export const releaseLegalHold = async (
  host: AdminAuditServiceHost,
  params: {
    actorUserId: string;
    input: AdminAuditLegalHoldsReleaseInput;
  },
) => {
  const filterSummary = buildAuditFilterSummary({});
  try {
    const db = host.db as LobeChatDatabase;
    const row = await db.transaction(async (tx) => {
      const legalHoldModel = new PlatformAuditLegalHoldModel(tx);
      const released = await legalHoldModel.release(params.input.id, {
        releasedBy: params.actorUserId,
        releaseReason: params.input.releaseReason,
      });
      if (!released) return null;
      await appendAuditAccessLog(tx, {
        action: 'admin.audit.legalHolds.release',
        actorUserId: params.actorUserId,
        afterDiff: { status: released.status },
        filterSummary,
        reason: params.input.releaseReason,
        required: true,
        result: 'success',
        targetId: released.id,
        targetType: 'legal_hold',
      });
      return released;
    });
    if (!row) {
      await appendAuditAccessLog(host.db, {
        action: 'admin.audit.legalHolds.release',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'not_found' },
        filterSummary,
        reason: params.input.releaseReason,
        result: 'failure',
        targetId: params.input.id,
        targetType: 'legal_hold',
      });
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
        httpCode: 'NOT_FOUND',
      });
    }
    return toLegalHoldPublic(row);
  } catch (error) {
    if (isNotFoundError(error)) throw error;
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.legalHolds.release',
      actorUserId: params.actorUserId,
      afterDiff: { error: 'failure' },
      filterSummary,
      reason: params.input.releaseReason,
      result: 'failure',
      targetId: params.input.id,
      targetType: 'legal_hold',
    });
    throw error;
  }
};
