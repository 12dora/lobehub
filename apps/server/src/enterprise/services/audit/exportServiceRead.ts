/**
 * List / get paths for AdminAuditExportService.
 */

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { PlatformAuditExportKind } from '@/database/models/platform';

import type { AdminAuditExportsListInputParsed } from '../../contracts/adminAudit';
import { getEnterpriseErrorBody, throwEnterpriseError } from '../../guards/enterpriseErrors';
import { appendAuditAccessLog, buildAuditFilterSummary } from './accessLog';
import type { ExportServiceHost } from './exportServiceHost';
import {
  accessLogResultForError,
  CONVERSATION_EXPORT_KINDS,
  toExportPublic,
} from './exportServiceShared';

export const listExports = async (
  host: ExportServiceHost,
  params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    input: AdminAuditExportsListInputParsed;
  },
) => {
  const filterSummary = buildAuditFilterSummary({
    cursor: params.input.cursor,
    kind: params.input.kind,
    limit: params.input.limit,
    status: params.input.status,
  });
  try {
    const { canReadConversations } = await host.assertConversationExportAccess(
      { actorPermissions: params.actorPermissions, actorUserId: params.actorUserId },
      params.input.kind,
    );

    // Without conversation read: only surface operation_logs (never leak privileged exports).
    const kindFilter: PlatformAuditExportKind | undefined = canReadConversations
      ? params.input.kind
      : 'operation_logs';

    const page = await host.exportsModel.list({
      cursor: params.input.cursor,
      kind: kindFilter,
      limit: params.input.limit,
      requestedBy: params.input.mine ? params.actorUserId : undefined,
      status: params.input.status,
    });

    // Defense in depth: drop any conversation kinds if somehow present.
    const items = canReadConversations
      ? page.items
      : page.items.filter((row) => !CONVERSATION_EXPORT_KINDS.includes(row.kind));

    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.exports.list',
      actorUserId: params.actorUserId,
      afterDiff: canReadConversations
        ? undefined
        : { conversationKindsHidden: true, kindFilter: 'operation_logs' },
      filterSummary,
      result: 'success',
      targetType: 'audit_export',
    });
    return {
      items: items.map(toExportPublic),
      nextCursor: page.nextCursor,
    };
  } catch (error) {
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.exports.list',
      actorUserId: params.actorUserId,
      afterDiff: { error: accessLogResultForError(error) },
      filterSummary,
      result: accessLogResultForError(error),
      targetType: 'audit_export',
    });
    throw error;
  }
};

export const getExport = async (
  host: ExportServiceHost,
  params: {
    actorPermissions?: readonly string[];
    actorUserId: string;
    id: string;
  },
) => {
  const filterSummary = buildAuditFilterSummary({});
  try {
    const row = await host.exportsModel.get(params.id);
    if (!row) {
      await appendAuditAccessLog(host.db, {
        action: 'admin.audit.exports.get',
        actorUserId: params.actorUserId,
        afterDiff: { error: 'not_found' },
        filterSummary,
        result: 'failure',
        targetId: params.id,
        targetType: 'audit_export',
      });
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
        httpCode: 'NOT_FOUND',
      });
    }

    await host.assertConversationExportAccess(
      { actorPermissions: params.actorPermissions, actorUserId: params.actorUserId },
      row.kind,
    );

    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.exports.get',
      actorUserId: params.actorUserId,
      filterSummary,
      result: 'success',
      targetId: row.id,
      targetType: 'audit_export',
    });
    return toExportPublic(row);
  } catch (error) {
    if (getEnterpriseErrorBody(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND) {
      throw error;
    }
    await appendAuditAccessLog(host.db, {
      action: 'admin.audit.exports.get',
      actorUserId: params.actorUserId,
      afterDiff: { error: accessLogResultForError(error) },
      filterSummary,
      result: accessLogResultForError(error),
      targetId: params.id,
      targetType: 'audit_export',
    });
    throw error;
  }
};
