/**
 * Admin user read projections (list/get/audit trail).
 */
import { PlatformAuditLogModel } from '@/database/models/platform';

import type {
  AdminUsersGetAuditTrailInputParsed,
  AdminUsersListInputParsed,
} from '../../contracts/adminUsers';
import { AdminUserNotFoundError, fingerprintQuery } from './errors';
import { AdminUserSupport } from './support';

export class AdminUserReadService extends AdminUserSupport {
  list = async (input: AdminUsersListInputParsed, meta?: { actorUserId?: string }) => {
    const result = await this.users.list({
      createdFrom: input.createdFrom,
      createdTo: input.createdTo,
      cursor: input.cursor,
      limit: input.limit,
      offset: input.offset,
      query: input.query,
      role: input.role,
      source: input.source,
      status: input.status,
    });

    // Access audit: filter classes only — never full query text.
    await this.appendAuditBestEffort({
      action: 'admin.users.list',
      actorUserId: meta?.actorUserId,
      afterDiff: {
        filterClasses: {
          hasCreatedRange: Boolean(input.createdFrom || input.createdTo),
          hasCursor: Boolean(input.cursor),
          hasOffset: Boolean(input.offset),
          hasQuery: Boolean(input.query),
          hasRole: Boolean(input.role),
          hasSource: Boolean(input.source),
          hasStatus: Boolean(input.status),
          queryFingerprint: fingerprintQuery(input.query),
        },
        itemCount: result.items.length,
        total: result.total,
      },
      result: 'success',
      targetType: 'user_list',
    });

    return result;
  };

  get = async (userId: string, meta?: { actorUserId?: string }) => {
    const detail = await this.users.findDetailById(userId);
    if (!detail) {
      await this.appendAuditBestEffort({
        action: 'admin.users.get',
        actorUserId: meta?.actorUserId,
        afterDiff: { error: 'not_found' },
        result: 'failure',
        targetId: userId,
        targetType: 'user',
      });
      throw new AdminUserNotFoundError();
    }

    await this.appendAuditBestEffort({
      action: 'admin.users.get',
      actorUserId: meta?.actorUserId,
      result: 'success',
      targetId: userId,
      targetType: 'user',
    });

    return {
      ...detail,
      isSelf: Boolean(meta?.actorUserId) && meta!.actorUserId === userId,
    };
  };

  getAuditTrail = async (
    input: AdminUsersGetAuditTrailInputParsed,
    meta?: { actorUserId?: string },
  ) => {
    const exists = await this.users.findBanState(input.userId);
    if (!exists) {
      await this.appendAuditBestEffort({
        action: 'admin.users.getAuditTrail',
        actorUserId: meta?.actorUserId,
        afterDiff: { error: 'not_found' },
        result: 'failure',
        targetId: input.userId,
        targetType: 'user',
      });
      throw new AdminUserNotFoundError();
    }

    const model = new PlatformAuditLogModel(this.db);
    const result = await model.list({
      cursor: input.cursor,
      limit: input.limit,
      targetId: input.userId,
      targetType: 'user',
    });

    await this.appendAuditBestEffort({
      action: 'admin.users.getAuditTrail',
      actorUserId: meta?.actorUserId,
      afterDiff: { itemCount: result.items.length },
      result: 'success',
      targetId: input.userId,
      targetType: 'user',
    });

    return {
      items: result.items.map((row) => ({
        action: row.action,
        actorUserId: row.actorUserId,
        createdAt: row.createdAt,
        id: row.id,
        reason: row.reason,
        result: row.result,
        targetId: row.targetId,
        targetType: row.targetType,
      })),
      nextCursor: result.nextCursor,
    };
  };
}
