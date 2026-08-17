import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import type { NetworkProxySubscriptionRow } from '@/database/models/platform/networkProxySubscription';
import { NetworkProxySubscriptionModel } from '@/database/models/platform/networkProxySubscription';
import type { LobeChatDatabase } from '@/database/type';
import { assessRegexSafety } from '@/types/platform/contentModeration';
import type {
  SubscriptionCreate,
  SubscriptionIssue,
  SubscriptionTraffic,
  SubscriptionUpdate,
  SubscriptionView,
} from '@/types/platform/networkProxy';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import type { OutboundPolicy } from '../../security/outboundHttp';
import { assertHostnamePolicy } from '../../security/outboundHttp';
import { redactSecrets } from './redact';
import { sealNetworkProxySecret } from './secrets';

/** Metadata blocked; private / loopback allowed (repo outbound policy for subscriptions). */
const SUBSCRIPTION_HOST_POLICY: OutboundPolicy = {
  allowlist: [],
  mode: 'allow-private',
};

const toTraffic = (row: NetworkProxySubscriptionRow): SubscriptionTraffic | null => {
  if (
    row.trafficUpload === null &&
    row.trafficDownload === null &&
    row.trafficTotal === null &&
    row.trafficExpireAt === null
  ) {
    return null;
  }
  return {
    download: row.trafficDownload,
    expireAt: row.trafficExpireAt ? row.trafficExpireAt.toISOString() : null,
    total: row.trafficTotal,
    upload: row.trafficUpload,
  };
};

const toView = (row: NetworkProxySubscriptionRow): SubscriptionView => ({
  createdAt: row.createdAt.toISOString(),
  enabled: row.enabled,
  id: row.id,
  kind: row.kind,
  lastIssue: row.lastIssue,
  lastUpdateAt: row.lastUpdateAt ? row.lastUpdateAt.toISOString() : null,
  name: row.name,
  nodeCount: row.nodeCount,
  sortOrder: row.sortOrder,
  traffic: toTraffic(row),
  updateIntervalSec: row.updateIntervalSec,
  updatedAt: row.updatedAt.toISOString(),
  urlHost: row.urlHost,
  userAgent: row.userAgent,
  ...(row.filter ? { filter: row.filter } : {}),
  ...(row.excludeFilter ? { excludeFilter: row.excludeFilter } : {}),
});

const assertSafeFilter = (pattern: string | null | undefined): void => {
  if (!pattern) return;
  const result = assessRegexSafety(pattern);
  if (!result.ok) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID,
      details: { reason: result.reason },
      message: 'Subscription filter regex is unsafe',
    });
  }
};

const hostnameFromUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID,
      message: 'Invalid subscription URL',
    });
  }
  try {
    assertHostnamePolicy(parsed.hostname, SUBSCRIPTION_HOST_POLICY);
  } catch {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID,
      message: 'Subscription URL host is not allowed',
    });
  }
  return parsed.hostname;
};

const requireRow = async (
  model: NetworkProxySubscriptionModel,
  id: string,
): Promise<NetworkProxySubscriptionRow> => {
  const row = await model.getById(id);
  if (!row) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
      message: 'Subscription not found',
    });
  }
  return row;
};

export const listSubscriptionViews = async (db: LobeChatDatabase): Promise<SubscriptionView[]> => {
  const rows = await new NetworkProxySubscriptionModel(db).list();
  return rows.map((row) => toView(row));
};

export const createSubscriptionRecord = async (
  db: LobeChatDatabase,
  input: SubscriptionCreate,
  userId: string,
): Promise<SubscriptionView> => {
  assertSafeFilter(input.filter);
  assertSafeFilter(input.excludeFilter);

  const model = new NetworkProxySubscriptionModel(db);
  const existing = await model.list();
  if (existing.length >= NETWORK_PROXY_LIMITS.SUBSCRIPTIONS_MAX) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID,
      message: 'Subscription limit reached',
    });
  }

  if (input.kind === 'url') {
    const urlHost = hostnameFromUrl(input.url);
    const urlCiphertext = await sealNetworkProxySecret(input.url);
    const row = await model.create({
      createdBy: userId,
      enabled: input.enabled,
      excludeFilter: input.excludeFilter ?? null,
      filter: input.filter ?? null,
      kind: 'url',
      name: input.name,
      sortOrder: input.sortOrder,
      updateIntervalSec: input.updateIntervalSec,
      urlCiphertext,
      urlHost,
      userAgent: input.userAgent ?? null,
    });
    return toView(row);
  }

  const payloadCiphertext = await sealNetworkProxySecret(input.payload);
  const row = await model.create({
    createdBy: userId,
    enabled: input.enabled,
    excludeFilter: input.excludeFilter ?? null,
    filter: input.filter ?? null,
    kind: 'manual',
    name: input.name,
    payloadCiphertext,
    sortOrder: input.sortOrder,
  });
  return toView(row);
};

export const updateSubscriptionRecord = async (
  db: LobeChatDatabase,
  input: SubscriptionUpdate,
  _userId: string,
): Promise<SubscriptionView> => {
  assertSafeFilter(input.filter ?? undefined);
  assertSafeFilter(input.excludeFilter ?? undefined);

  const model = new NetworkProxySubscriptionModel(db);
  const existing = await requireRow(model, input.id);

  if (input.url !== undefined && existing.kind !== 'url') {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID,
      message: 'url can only be updated on a url subscription',
    });
  }
  if (input.payload !== undefined && existing.kind !== 'manual') {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID,
      message: 'payload can only be updated on a manual subscription',
    });
  }

  const patch: Parameters<NetworkProxySubscriptionModel['update']>[1] = {
    enabled: input.enabled,
    excludeFilter: input.excludeFilter,
    filter: input.filter,
    name: input.name,
    sortOrder: input.sortOrder,
    updateIntervalSec: input.updateIntervalSec,
    userAgent: input.userAgent,
  };

  if (input.url !== undefined) {
    patch.urlHost = hostnameFromUrl(input.url);
    patch.urlCiphertext = await sealNetworkProxySecret(input.url);
  }
  if (input.payload !== undefined) {
    patch.payloadCiphertext = await sealNetworkProxySecret(input.payload);
  }

  const updated = await model.update(input.id, patch);
  if (!updated) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
      message: 'Subscription not found',
    });
  }
  return toView(updated);
};

export const deleteSubscriptionRecord = async (db: LobeChatDatabase, id: string): Promise<void> => {
  const model = new NetworkProxySubscriptionModel(db);
  await requireRow(model, id);
  await model.delete(id);
};

export const requestSubscriptionRefresh = async (
  db: LobeChatDatabase,
  id: string,
): Promise<void> => {
  const model = new NetworkProxySubscriptionModel(db);
  await requireRow(model, id);
  await model.requestRefresh(id, new Date());
};

const redactIssue = (issue: SubscriptionIssue): SubscriptionIssue => ({
  ...issue,
  detail: issue.detail ? redactSecrets(issue.detail).slice(0, 200) : null,
});

export const recordSubscriptionFetchResult = async (
  db: LobeChatDatabase,
  id: string,
  result: {
    fetchedAt: Date;
    lastIssue?: SubscriptionIssue | null;
    nodeCount?: number | null;
    traffic?: SubscriptionTraffic | null;
  },
): Promise<void> => {
  await new NetworkProxySubscriptionModel(db).recordFetchResult(id, {
    fetchedAt: result.fetchedAt,
    lastIssue: result.lastIssue ? redactIssue(result.lastIssue) : result.lastIssue,
    nodeCount: result.nodeCount,
    traffic: result.traffic,
  });
};

/**
 * Parse a Clash-style `subscription-userinfo` header.
 * Example: `upload=1; download=2; total=3; expire=1700000000`
 */
export const parseSubscriptionUserinfoHeader = (
  value: string | null | undefined,
): SubscriptionTraffic | null => {
  if (!value) return null;
  const parts: Record<string, string> = {};
  for (const segment of value.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    parts[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim();
  }

  const parseNonNegative = (raw: string | undefined): number | null => {
    if (raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const upload = parseNonNegative(parts.upload);
  const download = parseNonNegative(parts.download);
  const total = parseNonNegative(parts.total);
  let expireAt: string | null = null;
  if (parts.expire) {
    const unix = Number(parts.expire);
    if (Number.isFinite(unix) && unix > 0) {
      expireAt = new Date(unix * 1000).toISOString();
    }
  }

  if (upload === null && download === null && total === null && expireAt === null) return null;
  return { download, expireAt, total, upload };
};
