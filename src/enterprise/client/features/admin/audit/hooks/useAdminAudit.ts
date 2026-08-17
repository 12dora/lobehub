'use client';

import { toast } from '@lobehub/ui/base-ui';
import debug from 'debug';
import i18n from 'i18next';
import { useCallback } from 'react';

import {
  type AdminAuditEventsListInput,
  type AdminAuditExportItem,
  type AdminAuditExportsCancelInput,
  type AdminAuditExportsCreateInput,
  type AdminAuditExportsDownloadInput,
  type AdminAuditLegalHoldItem,
  type AdminAuditLegalHoldsCreateInput,
  type AdminAuditLegalHoldsReleaseInput,
  type AdminAuditPolicyUpdateInput,
  type AdminAuditRetentionCancelInput,
  type AdminAuditRetentionCreateInput,
  type AdminAuditRetentionRunItem,
  adminAuditService,
} from '@/enterprise/client/services/adminAudit';
import { mutate, useClientDataSWR } from '@/libs/swr';

import {
  ADMIN_AUDIT_EXPORTS_LIST_KEY,
  ADMIN_AUDIT_HOLDS_LIST_KEY,
  ADMIN_AUDIT_POLICY_KEY,
  ADMIN_AUDIT_RETENTION_RUNS_KEY,
  buildAdminAuditConversationGetKey,
  buildAdminAuditConversationMessagesKey,
  buildAdminAuditConversationsListKey,
  buildAdminAuditEventDetailKey,
  buildAdminAuditEventsFacetsKey,
  buildAdminAuditEventsListKey,
  buildAdminAuditEventsStatsKey,
  buildAdminAuditExportsListKey,
  buildAdminAuditHoldsListKey,
  buildAdminAuditPolicyKey,
  buildAdminAuditRetentionRunsKey,
  buildAdminAuditUserSummaryKey,
  buildAdminAuditUserTimelineKey,
} from '../swrKeys';

const log = debug('lobe-client:admin:audit');

export const useFetchAuditEventsList = (
  filters: AdminAuditEventsListInput & { cursor?: string | null },
  enabled = true,
) => {
  const key = enabled ? buildAdminAuditEventsListKey(filters) : null;
  return useClientDataSWR(key, () =>
    adminAuditService.listEvents({
      action: filters.action,
      actions: filters.actions,
      actorUserId: filters.actorUserId,
      cursor: filters.cursor ?? undefined,
      from: filters.from,
      limit: filters.limit,
      requestId: filters.requestId,
      result: filters.result,
      results: filters.results,
      targetId: filters.targetId,
      targetType: filters.targetType,
      to: filters.to,
    }),
  );
};

export const useFetchAuditEventDetail = (id: string | undefined, enabled = true) => {
  const key = enabled && id ? buildAdminAuditEventDetailKey(id) : null;
  return useClientDataSWR(key, () => adminAuditService.getEvent({ id: id! }));
};

export const useFetchAuditEventFacets = (window: { from?: Date; to?: Date }, enabled = true) => {
  const key = enabled ? buildAdminAuditEventsFacetsKey(window.from, window.to) : null;
  return useClientDataSWR(key, () =>
    adminAuditService.getEventFacets({ from: window.from, to: window.to }),
  );
};

export const useFetchAuditEventStats = (window: { from?: Date; to?: Date }, enabled = true) => {
  const key = enabled ? buildAdminAuditEventsStatsKey(window.from, window.to) : null;
  return useClientDataSWR(key, () =>
    adminAuditService.getEventStats({ from: window.from, to: window.to }),
  );
};

export const useFetchAuditPolicy = (enabled = true) => {
  const key = buildAdminAuditPolicyKey(enabled);
  return useClientDataSWR(key, () => adminAuditService.getPolicy());
};

export const useFetchAuditConversationsList = (
  params: {
    cursor?: string | null;
    from?: Date;
    limit?: number;
    q?: string;
    to?: Date;
    userId: string;
  },
  enabled = true,
  options?: { refreshInterval?: number },
) => {
  const key = enabled && params.userId ? buildAdminAuditConversationsListKey(params) : null;
  return useClientDataSWR(
    key,
    () =>
      adminAuditService.listConversations({
        cursor: params.cursor ?? undefined,
        from: params.from,
        limit: params.limit,
        q: params.q,
        to: params.to,
        userId: params.userId,
      }),
    { refreshInterval: options?.refreshInterval },
  );
};

export const useFetchAuditConversation = (
  userId: string | undefined,
  topicId: string | undefined,
  enabled = true,
) => {
  const key =
    enabled && userId && topicId ? buildAdminAuditConversationGetKey(userId, topicId) : null;
  return useClientDataSWR(key, () =>
    adminAuditService.getConversation({ topicId: topicId!, userId: userId! }),
  );
};

export const useFetchAuditConversationMessages = (
  params: {
    cursor?: string | null;
    includeBody?: boolean;
    limit?: number;
    topicId: string;
    userId: string;
  },
  enabled = true,
  options?: { refreshInterval?: number },
) => {
  const key =
    enabled && params.userId && params.topicId
      ? buildAdminAuditConversationMessagesKey(params)
      : null;
  return useClientDataSWR(
    key,
    () =>
      adminAuditService.listConversationMessages({
        cursor: params.cursor ?? undefined,
        includeBody: params.includeBody,
        limit: params.limit,
        topicId: params.topicId,
        userId: params.userId,
      }),
    { refreshInterval: options?.refreshInterval },
  );
};

export const useFetchAuditUserSummary = (userId: string | undefined, enabled = true) => {
  const key = enabled && userId ? buildAdminAuditUserSummaryKey(userId) : null;
  return useClientDataSWR(key, () => adminAuditService.getUserSummary({ userId: userId! }));
};

export const useFetchAuditUserTimeline = (
  params: {
    cursor?: string | null;
    from?: Date;
    limit?: number;
    to?: Date;
    userId: string;
  },
  enabled = true,
) => {
  const key = enabled && params.userId ? buildAdminAuditUserTimelineKey(params) : null;
  return useClientDataSWR(key, () =>
    adminAuditService.getUserTimeline({
      cursor: params.cursor ?? undefined,
      from: params.from,
      limit: params.limit,
      to: params.to,
      userId: params.userId,
    }),
  );
};

export const useFetchAuditExportsList = (
  params: {
    cursor?: string | null;
    kind?: AdminAuditExportItem['kind'];
    limit?: number;
    mine?: boolean;
    status?: AdminAuditExportItem['status'];
  },
  enabled = true,
  options?: {
    refreshInterval?: number | ((data: { items: AdminAuditExportItem[] } | undefined) => number);
  },
) => {
  const key = enabled ? buildAdminAuditExportsListKey(params) : null;
  return useClientDataSWR(
    key,
    () =>
      adminAuditService.listExports({
        cursor: params.cursor ?? undefined,
        kind: params.kind,
        limit: params.limit,
        mine: params.mine,
        status: params.status,
      }),
    { refreshInterval: options?.refreshInterval },
  );
};

export const useFetchAuditHoldsList = (
  params: {
    cursor?: string | null;
    limit?: number;
    scopeType?: AdminAuditLegalHoldItem['scopeType'];
    /** Stored filter only — projected `expired` is not listable. */
    status?: 'active' | 'released';
  },
  enabled = true,
) => {
  const key = enabled ? buildAdminAuditHoldsListKey(params) : null;
  return useClientDataSWR(key, () =>
    adminAuditService.listLegalHolds({
      cursor: params.cursor ?? undefined,
      limit: params.limit,
      scopeType: params.scopeType,
      status: params.status,
    }),
  );
};

export const useFetchAuditRetentionRuns = (
  params: {
    cursor?: string | null;
    limit?: number;
    mode?: AdminAuditRetentionRunItem['mode'];
    mine?: boolean;
    scope?: AdminAuditRetentionRunItem['scope'];
    status?: AdminAuditRetentionRunItem['status'];
  },
  enabled = true,
  options?: {
    refreshInterval?:
      number | ((data: { items: AdminAuditRetentionRunItem[] } | undefined) => number);
  },
) => {
  const key = enabled ? buildAdminAuditRetentionRunsKey(params) : null;
  return useClientDataSWR(
    key,
    () =>
      adminAuditService.listRetentionRuns({
        cursor: params.cursor ?? undefined,
        limit: params.limit,
        mode: params.mode,
        mine: params.mine,
        scope: params.scope,
        status: params.status,
      }),
    { refreshInterval: options?.refreshInterval },
  );
};

export const refreshAuditExportsList = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_AUDIT_EXPORTS_LIST_KEY);
};

export const refreshAuditHoldsList = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_AUDIT_HOLDS_LIST_KEY);
};

export const refreshAuditRetentionRuns = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_AUDIT_RETENTION_RUNS_KEY);
};

export const refreshAuditPolicy = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_AUDIT_POLICY_KEY);
};

/**
 * Best-effort cache invalidation after a successful audit mutation.
 * Never rethrows — a refresh failure must not surface as a mutation failure
 * (would invite unsafe retries of irreversible commits such as holds/exports/runs).
 */
const softRefresh = async (tasks: Array<() => Promise<unknown>>) => {
  const results = await Promise.allSettled(tasks.map((task) => task()));
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (!rejected) return;

  log('post-commit refresh failed: %O', rejected.reason);
  toast.warning(
    String(
      i18n.t('audit.toast.savedRefreshFailed' as never, {
        defaultValue: 'Saved, but the latest view could not be refreshed.',
        ns: 'admin',
      }),
    ),
  );
};

export const useAdminAuditMutations = () => {
  const updatePolicy = useCallback(async (input: AdminAuditPolicyUpdateInput) => {
    const result = await adminAuditService.updatePolicy(input);
    await softRefresh([() => refreshAuditPolicy()]);
    return result;
  }, []);

  const createExport = useCallback(async (input: AdminAuditExportsCreateInput) => {
    const result = await adminAuditService.createExport(input);
    await softRefresh([() => refreshAuditExportsList()]);
    return result;
  }, []);

  const downloadExport = useCallback(async (input: AdminAuditExportsDownloadInput) => {
    return adminAuditService.downloadExport(input);
  }, []);

  const cancelExport = useCallback(async (input: AdminAuditExportsCancelInput) => {
    const result = await adminAuditService.cancelExport(input);
    await softRefresh([() => refreshAuditExportsList()]);
    return result;
  }, []);

  const createLegalHold = useCallback(async (input: AdminAuditLegalHoldsCreateInput) => {
    const result = await adminAuditService.createLegalHold(input);
    await softRefresh([() => refreshAuditHoldsList()]);
    return result;
  }, []);

  const releaseLegalHold = useCallback(async (input: AdminAuditLegalHoldsReleaseInput) => {
    const result = await adminAuditService.releaseLegalHold(input);
    await softRefresh([() => refreshAuditHoldsList()]);
    return result;
  }, []);

  const retentionDryRun = useCallback(async (input: AdminAuditRetentionCreateInput) => {
    const result = await adminAuditService.retentionDryRun(input);
    await softRefresh([() => refreshAuditRetentionRuns()]);
    return result;
  }, []);

  const retentionRun = useCallback(async (input: AdminAuditRetentionCreateInput) => {
    const result = await adminAuditService.retentionRun(input);
    await softRefresh([() => refreshAuditRetentionRuns()]);
    return result;
  }, []);

  const cancelRetentionRun = useCallback(async (input: AdminAuditRetentionCancelInput) => {
    const result = await adminAuditService.cancelRetentionRun(input);
    await softRefresh([() => refreshAuditRetentionRuns()]);
    return result;
  }, []);

  return {
    cancelExport,
    cancelRetentionRun,
    createExport,
    createLegalHold,
    downloadExport,
    releaseLegalHold,
    retentionDryRun,
    retentionRun,
    updatePolicy,
  };
};
