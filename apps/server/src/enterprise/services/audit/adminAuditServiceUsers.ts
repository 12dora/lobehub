/**
 * User search / summary / timeline for AdminAuditService (SAO-009).
 */

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import type {
  AdminAuditUsersSearchInputParsed,
  AdminAuditUsersTimelineInputParsed,
} from '../../contracts/adminAudit';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { appendAuditAccessLog, buildAuditFilterSummary } from './accessLog';
import type { AdminAuditServiceHost } from './adminAuditServiceHost';
import { isNotFoundError, maskOptionalText } from './adminAuditServiceShared';
import { assertConversationAccessEnabled } from './contentPolicy';
import { resolveAuditTimeWindow } from './timeWindow';

export const searchUsers = async (
  host: AdminAuditServiceHost,
  params: {
    actorUserId: string;
    input: AdminAuditUsersSearchInputParsed;
  },
) => {
  const filterSummary = buildAuditFilterSummary({
    cursor: params.input.cursor,
    hasQ: true,
    limit: params.input.limit,
  });
  try {
    const page = await host.conversationModel.searchUsers({
      cursor: params.input.cursor,
      limit: params.input.limit,
      q: params.input.q,
    });
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.users.search',
      actorUserId: params.actorUserId,
      filterSummary,
      result: 'success',
      targetType: 'user',
    });
    return page;
  } catch (error) {
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.users.search',
      actorUserId: params.actorUserId,
      afterDiff: { error: 'failure' },
      filterSummary,
      result: 'failure',
      targetType: 'user',
    });
    throw error;
  }
};

export const getUserSummary = async (
  host: AdminAuditServiceHost,
  params: { actorUserId: string; userId: string },
) => {
  const filterSummary = buildAuditFilterSummary({ userId: params.userId });
  try {
    const summary = await host.conversationModel.getUserSummary(params.userId);
    if (!summary) {
      await appendAuditAccessLog(host.db, {
        action: 'admin.audit.users.summary',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'not_found' },
        filterSummary,
        result: 'failure',
        targetId: params.userId,
        targetType: 'user',
      });
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
        httpCode: 'NOT_FOUND',
      });
    }
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.users.summary',
      actorUserId: params.actorUserId,
      filterSummary,
      result: 'success',
      targetId: params.userId,
      targetType: 'user',
    });
    return summary;
  } catch (error) {
    if (isNotFoundError(error)) throw error;
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.users.summary',
      actorUserId: params.actorUserId,
      afterDiff: { error: 'failure' },
      filterSummary,
      result: 'failure',
      targetId: params.userId,
      targetType: 'user',
    });
    throw error;
  }
};

export const listUserTimeline = async (
  host: AdminAuditServiceHost,
  params: {
    actorUserId: string;
    input: AdminAuditUsersTimelineInputParsed;
  },
) => {
  const filterSummary = buildAuditFilterSummary({
    cursor: params.input.cursor,
    from: params.input.from,
    limit: params.input.limit,
    to: params.input.to,
    userId: params.input.userId,
  });
  try {
    const policy = await host.policyModel.getOrCreate();
    assertConversationAccessEnabled(policy.contentAccessMode);
    const window = resolveAuditTimeWindow({
      from: params.input.from,
      maxListWindowDays: policy.maxListWindowDays,
      to: params.input.to,
    });
    const page = await host.conversationModel.listUserTimeline({
      cursor: params.input.cursor,
      from: window.from,
      limit: params.input.limit,
      to: window.to,
      userId: params.input.userId,
    });
    const items = page.items.map((row) => ({
      ...row,
      title: maskOptionalText(row.title, policy.redactionProfile) ?? null,
    }));
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.users.timeline',
      actorUserId: params.actorUserId,
      filterSummary,
      result: 'success',
      targetId: params.input.userId,
      targetType: 'user',
    });
    return { items, nextCursor: page.nextCursor, redactionProfile: policy.redactionProfile };
  } catch (error) {
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.users.timeline',
      actorUserId: params.actorUserId,
      afterDiff: { error: 'failure' },
      filterSummary,
      result: 'failure',
      targetId: params.input.userId,
      targetType: 'user',
    });
    throw error;
  }
};
