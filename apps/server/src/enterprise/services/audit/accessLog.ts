/**
 * Audit-the-auditor helpers: stable bounded filter summaries and access log append.
 * Never copies message body or free-text query strings into access logs.
 */

import type { PlatformAuditResult } from '@/database/models/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { AdminAuditAccessFilterSummary } from '../../contracts/adminAudit';
import { PlatformAuditService } from '../platformAudit';
import type { AuditTargetType } from './auditActionCatalog';

export { buildAuditFilterSummary } from './accessLogFilterSummary';

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
  | 'admin.audit.exports.worker'
  | 'admin.audit.get'
  | 'admin.audit.legalHolds.create'
  | 'admin.audit.legalHolds.get'
  | 'admin.audit.legalHolds.list'
  | 'admin.audit.legalHolds.release'
  | 'admin.audit.list'
  | 'admin.audit.policy.get'
  | 'admin.audit.policy.update'
  | 'admin.audit.retention.cancel'
  | 'admin.audit.retention.dryRun'
  | 'admin.audit.retention.getRun'
  | 'admin.audit.retention.listRuns'
  | 'admin.audit.retention.run'
  | 'admin.audit.retention.status'
  | 'admin.audit.retention.worker'
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
  /**
   * When true, append failures propagate (fail closed). Use for sensitive
   * mutations and evidence downloads. Default false keeps best-effort reads.
   */
  required?: boolean;
  result: PlatformAuditResult;
  targetId?: string | null;
  targetType: AuditTargetType;
}

/**
 * Append an audit-the-auditor row.
 * Default is best-effort (failures logged and swallowed) for low-risk reads.
 * Pass `required: true` for sensitive mutations / downloads so append failure
 * fails the caller's operation (fail closed).
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
      required: Boolean(params.required),
      result: params.result,
    });
    if (params.required) throw error;
  }
};
