import type { AdminAuditEventsListInput } from '@/server/enterprise/contracts/adminAudit';

export const ADMIN_AUDIT_EVENTS_LIST_KEY = 'admin.audit.events.list' as const;
export const ADMIN_AUDIT_EVENTS_GET_KEY = 'admin.audit.events.get' as const;
export const ADMIN_AUDIT_EVENTS_FACETS_KEY = 'admin.audit.events.facets' as const;
export const ADMIN_AUDIT_EVENTS_STATS_KEY = 'admin.audit.events.stats' as const;
export const ADMIN_AUDIT_POLICY_KEY = 'admin.audit.policy.get' as const;
export const ADMIN_AUDIT_CONVERSATIONS_LIST_KEY = 'admin.audit.conversations.list' as const;
export const ADMIN_AUDIT_CONVERSATIONS_GET_KEY = 'admin.audit.conversations.get' as const;
export const ADMIN_AUDIT_CONVERSATIONS_MESSAGES_KEY = 'admin.audit.conversations.messages' as const;
export const ADMIN_AUDIT_USERS_SUMMARY_KEY = 'admin.audit.users.summary' as const;
export const ADMIN_AUDIT_USERS_TIMELINE_KEY = 'admin.audit.users.timeline' as const;
export const ADMIN_AUDIT_EXPORTS_LIST_KEY = 'admin.audit.exports.list' as const;
export const ADMIN_AUDIT_HOLDS_LIST_KEY = 'admin.audit.legalHolds.list' as const;
export const ADMIN_AUDIT_RETENTION_RUNS_KEY = 'admin.audit.retention.listRuns' as const;

const iso = (value?: Date | string | null) => {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
};

export const buildAdminAuditEventsListKey = (
  filters: AdminAuditEventsListInput & { cursor?: string | null },
) =>
  [
    ADMIN_AUDIT_EVENTS_LIST_KEY,
    filters.action ?? '',
    (filters.actions ?? []).join(','),
    filters.actorUserId ?? '',
    iso(filters.from),
    iso(filters.to),
    filters.requestId ?? '',
    filters.result ?? '',
    (filters.results ?? []).join(','),
    filters.targetId ?? '',
    filters.targetType ?? '',
    filters.cursor ?? '',
    filters.limit ?? 50,
  ] as const;

export const buildAdminAuditEventDetailKey = (id: string) =>
  [ADMIN_AUDIT_EVENTS_GET_KEY, id] as const;

export const buildAdminAuditEventsFacetsKey = (from?: Date, to?: Date) =>
  [ADMIN_AUDIT_EVENTS_FACETS_KEY, iso(from), iso(to)] as const;

export const buildAdminAuditEventsStatsKey = (from?: Date, to?: Date) =>
  [ADMIN_AUDIT_EVENTS_STATS_KEY, iso(from), iso(to)] as const;

export const buildAdminAuditPolicyKey = (enabled: boolean) =>
  enabled ? ([ADMIN_AUDIT_POLICY_KEY] as const) : null;

export const buildAdminAuditConversationsListKey = (params: {
  cursor?: string | null;
  from?: Date;
  limit?: number;
  q?: string;
  to?: Date;
  userId: string;
}) =>
  [
    ADMIN_AUDIT_CONVERSATIONS_LIST_KEY,
    params.userId,
    params.q ?? '',
    iso(params.from),
    iso(params.to),
    params.cursor ?? '',
    params.limit ?? 50,
  ] as const;

export const buildAdminAuditConversationGetKey = (userId: string, topicId: string) =>
  [ADMIN_AUDIT_CONVERSATIONS_GET_KEY, userId, topicId] as const;

export const buildAdminAuditConversationMessagesKey = (params: {
  cursor?: string | null;
  includeBody?: boolean;
  limit?: number;
  topicId: string;
  userId: string;
}) =>
  [
    ADMIN_AUDIT_CONVERSATIONS_MESSAGES_KEY,
    params.userId,
    params.topicId,
    params.includeBody ? '1' : '0',
    params.cursor ?? '',
    params.limit ?? 50,
  ] as const;

export const buildAdminAuditUserSummaryKey = (userId: string) =>
  [ADMIN_AUDIT_USERS_SUMMARY_KEY, userId] as const;

export const buildAdminAuditUserTimelineKey = (params: {
  cursor?: string | null;
  from?: Date;
  limit?: number;
  to?: Date;
  userId: string;
}) =>
  [
    ADMIN_AUDIT_USERS_TIMELINE_KEY,
    params.userId,
    iso(params.from),
    iso(params.to),
    params.cursor ?? '',
    params.limit ?? 50,
  ] as const;

export const buildAdminAuditExportsListKey = (params: {
  cursor?: string | null;
  kind?: string;
  limit?: number;
  mine?: boolean;
  status?: string;
}) =>
  [
    ADMIN_AUDIT_EXPORTS_LIST_KEY,
    params.kind ?? '',
    params.status ?? '',
    params.mine ? '1' : '0',
    params.cursor ?? '',
    params.limit ?? 50,
  ] as const;

export const buildAdminAuditHoldsListKey = (params: {
  cursor?: string | null;
  limit?: number;
  scopeType?: string;
  status?: string;
}) =>
  [
    ADMIN_AUDIT_HOLDS_LIST_KEY,
    params.status ?? '',
    params.scopeType ?? '',
    params.cursor ?? '',
    params.limit ?? 50,
  ] as const;

export const buildAdminAuditRetentionRunsKey = (params: {
  cursor?: string | null;
  limit?: number;
  mode?: string;
  mine?: boolean;
  scope?: string;
  status?: string;
}) =>
  [
    ADMIN_AUDIT_RETENTION_RUNS_KEY,
    params.mode ?? '',
    params.scope ?? '',
    params.status ?? '',
    params.mine ? '1' : '0',
    params.cursor ?? '',
    params.limit ?? 50,
  ] as const;
