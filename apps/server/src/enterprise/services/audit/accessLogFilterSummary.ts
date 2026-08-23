/**
 * Bounded, free-text-free filter summaries for audit-the-auditor access logs.
 */

import type { AdminAuditAccessFilterSummary } from '../../contracts/adminAudit';

type PresenceFlag = {
  [K in keyof AdminAuditAccessFilterSummary]-?: AdminAuditAccessFilterSummary[K] extends
    boolean | undefined
    ? K
    : never;
}[keyof AdminAuditAccessFilterSummary];

const setWhenPresent = <K extends keyof AdminAuditAccessFilterSummary>(
  summary: AdminAuditAccessFilterSummary,
  key: K,
  value: AdminAuditAccessFilterSummary[K] | null | undefined,
): void => {
  if (value != null) summary[key] = value;
};

const flagWhen = (
  summary: AdminAuditAccessFilterSummary,
  key: PresenceFlag,
  present: boolean,
): void => {
  if (present) summary[key] = true;
};

const resultFilterPresent = (
  result: string | null | undefined,
  results: string[] | null | undefined,
): boolean => result != null || (results != null && results.length > 0);

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
  /** Retention mode only (structured enum string). */
  mode?: string | null;
  requestId?: string | null;
  result?: string | null;
  results?: string[] | null;
  /** Retention scope only (structured enum string). */
  scope?: string | null;
  scopeType?: string | null;
  /** Export/retention status filter (structured enum string). */
  status?: string | null;
  targetId?: string | null;
  targetType?: string | null;
  to?: Date | null;
  topicId?: string | null;
  userId?: string | null;
}): AdminAuditAccessFilterSummary => {
  const summary: AdminAuditAccessFilterSummary = {};
  flagWhen(summary, 'actionPresent', params.action != null);
  if (params.actions != null) summary.actionsCount = params.actions.length;
  flagWhen(summary, 'actorUserIdPresent', params.actorUserId != null);
  flagWhen(summary, 'cursorPresent', params.cursor != null);
  flagWhen(summary, 'fromPresent', params.from != null);
  setWhenPresent(summary, 'hasQ', params.hasQ);
  setWhenPresent(summary, 'includeBody', params.includeBody);
  setWhenPresent(summary, 'kind', params.kind);
  setWhenPresent(summary, 'limit', params.limit);
  setWhenPresent(summary, 'mode', params.mode);
  flagWhen(summary, 'requestIdPresent', params.requestId != null);
  flagWhen(summary, 'resultPresent', resultFilterPresent(params.result, params.results));
  setWhenPresent(summary, 'scope', params.scope);
  setWhenPresent(summary, 'scopeType', params.scopeType);
  setWhenPresent(summary, 'status', params.status);
  flagWhen(summary, 'targetIdPresent', params.targetId != null);
  flagWhen(summary, 'targetTypePresent', params.targetType != null);
  flagWhen(summary, 'toPresent', params.to != null);
  flagWhen(summary, 'topicIdPresent', params.topicId != null);
  flagWhen(summary, 'userIdPresent', params.userId != null);
  return summary;
};
