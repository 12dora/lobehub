/**
 * Audit-the-auditor helpers: stable bounded filter summaries and access log append.
 * Never copies message body or free-text query strings into access logs.
 */

import type { PlatformAuditResult } from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { AdminAuditAccessFilterSummary } from '../../contracts/adminAudit';
import { PlatformAuditService } from '../platformAudit';

export type AuditAccessAction =
  | 'admin.audit.conversations.get'
  | 'admin.audit.conversations.list'
  | 'admin.audit.conversations.messages'
  | 'admin.audit.events.facets'
  | 'admin.audit.events.get'
  | 'admin.audit.events.list'
  | 'admin.audit.events.stats'
  | 'admin.audit.exports.cancel'
  | 'admin.audit.exports.create'
  | 'admin.audit.exports.download'
  | 'admin.audit.exports.get'
  | 'admin.audit.exports.list'
  | 'admin.audit.get'
  | 'admin.audit.legalHolds.create'
  | 'admin.audit.legalHolds.get'
  | 'admin.audit.legalHolds.list'
  | 'admin.audit.legalHolds.release'
  | 'admin.audit.list'
  | 'admin.audit.policy.get'
  | 'admin.audit.policy.update'
  | 'admin.audit.users.search'
  | 'admin.audit.users.summary'
  | 'admin.audit.users.timeline';

export interface AppendAuditAccessLogParams {
  action: AuditAccessAction;
  actorUserId: string;
  afterDiff?: Record<string, unknown> | null;
  beforeDiff?: Record<string, unknown> | null;
  /** Stable filter summary only — no free text. */
  filterSummary?: AdminAuditAccessFilterSummary | null;
  reason?: string | null;
  result: PlatformAuditResult;
  targetId?: string | null;
  targetType: string;
}

/** Build a bounded, free-text-free summary from known structured filter fields. */
export const buildAuditFilterSummary = (params: {
  action?: string | null;
  actions?: string[] | null;
  actorUserId?: string | null;
  cursor?: string | null;
  from?: Date | null;
  hasQ?: boolean;
  includeBody?: boolean;
  /** Export kind only (structured enum string — never free text). */
  kind?: string | null;
  limit?: number;
  requestId?: string | null;
  result?: string | null;
  results?: string[] | null;
  scopeType?: string | null;
  /** Export status filter (structured enum string). */
  status?: string | null;
  targetId?: string | null;
  targetType?: string | null;
  to?: Date | null;
  topicId?: string | null;
  userId?: string | null;
}): AdminAuditAccessFilterSummary => {
  const summary: AdminAuditAccessFilterSummary = {};
  if (params.action != null) summary.actionPresent = true;
  if (params.actions != null) summary.actionsCount = params.actions.length;
  if (params.actorUserId != null) summary.actorUserIdPresent = true;
  if (params.cursor != null) summary.cursorPresent = true;
  if (params.from != null) summary.fromPresent = true;
  if (params.hasQ != null) summary.hasQ = params.hasQ;
  if (params.includeBody != null) summary.includeBody = params.includeBody;
  if (params.kind != null) summary.kind = params.kind;
  if (params.limit != null) summary.limit = params.limit;
  if (params.requestId != null) summary.requestIdPresent = true;
  if (params.result != null || (params.results != null && params.results.length > 0)) {
    summary.resultPresent = true;
  }
  if (params.scopeType != null) summary.scopeType = params.scopeType;
  if (params.status != null) summary.status = params.status;
  if (params.targetId != null) summary.targetIdPresent = true;
  if (params.targetType != null) summary.targetTypePresent = true;
  if (params.to != null) summary.toPresent = true;
  if (params.topicId != null) summary.topicIdPresent = true;
  if (params.userId != null) summary.userIdPresent = true;
  return summary;
};

/**
 * Best-effort append of an audit-the-auditor row.
 * Failures are logged and swallowed so the original business error remains authoritative.
 */
export const appendAuditAccessLog = async (
  db: LobeChatDatabase | Transaction,
  params: AppendAuditAccessLogParams,
): Promise<void> => {
  try {
    const afterDiff: Record<string, unknown> = {
      ...params.afterDiff,
      ...(params.filterSummary ? { filterSummary: params.filterSummary } : {}),
    };
    await new PlatformAuditService(db).append({
      action: params.action,
      actorUserId: params.actorUserId,
      afterDiff: Object.keys(afterDiff).length > 0 ? afterDiff : null,
      beforeDiff: params.beforeDiff ?? null,
      reason: params.reason ?? null,
      result: params.result,
      targetId: params.targetId ?? null,
      targetType: params.targetType,
    });
  } catch (error) {
    console.error('[admin.audit] access log append failed', {
      action: params.action,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
      result: params.result,
    });
  }
};
