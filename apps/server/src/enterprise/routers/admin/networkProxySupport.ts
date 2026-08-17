/**
 * admin.networkProxy helpers: audit tokens, B1/B2/B3 runtime seam, CAS summaries,
 * artifact upload, and outlet connectivity (never logs URLs / passwords / payloads).
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import { TRPCError } from '@trpc/server';
import debug from 'debug';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { EgressScopeId } from '@/const/platform/networkProxy';
import { NETWORK_PROXY_ENGINE_MANIFEST, NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import { NetworkProxySettingsModel } from '@/database/models/platform/networkProxySettings';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  ArtifactState,
  DesiredArtifacts,
  EgressScopeOp,
  InstanceStatusView,
  NetworkProxyArtifactKind,
  NetworkProxyConfig,
  NetworkProxyConfigUpdate,
  NetworkProxyConfigView,
  NetworkProxyEngineState,
  OutletConfig,
  ProxyNodeView,
  StaticProxyPersisted,
  StaticProxyUpdate,
  SubscriptionCreate,
  SubscriptionUpdate,
  SubscriptionView,
} from '@/types/platform/networkProxy';

import type {
  AdminNetworkProxyLocalOutcome,
  AdminNetworkProxySettingsMutationOutput,
  AdminNetworkProxySettingsOutput,
} from '../../contracts/adminNetworkProxy';
import { getEnterpriseErrorBody, throwEnterpriseError } from '../../guards/enterpriseErrors';
import type { AuditAction, AuditTargetType } from '../../services/audit/auditActionCatalog';
import {
  NETWORK_PROXY_AUDIT_ACTIONS as B1_AUDIT_ACTIONS,
  NETWORK_PROXY_AUDIT_TARGET_TYPES as B1_AUDIT_TARGET_TYPES,
  NETWORK_PROXY_SETTINGS_ID,
} from '../../services/networkProxy/constants';
import { getEgressCounters } from '../../services/networkProxy/egress/counters';
import { getDispatcher } from '../../services/networkProxy/egress/dispatchers';
import { getOutletHealth } from '../../services/networkProxy/egress/router';
import { artifactManager } from '../../services/networkProxy/engine/artifacts';
import { resolveEngineIssueCode } from '../../services/networkProxy/engine/errors';
import { buildLocalInstanceStatus } from '../../services/networkProxy/engine/instanceStatusReporter';
import { detectEnginePlatform } from '../../services/networkProxy/engine/platform';
import { getEngineRuntime } from '../../services/networkProxy/engine/runtime';
import {
  type InstanceStatusUpsert,
  listFreshInstanceStatuses,
} from '../../services/networkProxy/instanceStatusService';
import { redactSecrets } from '../../services/networkProxy/redact';
import {
  applyScopeOps,
  applyStaticProxyUpdate,
  assertCanEnable,
  getNetworkProxySettings,
  isLegacyGlobalProxyActive,
  toNetworkProxyConfigView,
  updateNetworkProxySettings,
} from '../../services/networkProxy/settingsService';
import {
  peekNetworkProxySnapshot,
  publishNetworkProxyInvalidation,
} from '../../services/networkProxy/snapshot';
import {
  createSubscriptionRecord,
  deleteSubscriptionRecord,
  listSubscriptionViews,
  requestSubscriptionRefresh,
  updateSubscriptionRecord,
} from '../../services/networkProxy/subscriptionsService';
import { getPlatformInstanceId } from '../../services/platformInstance/heartbeatRuntime';

const log = debug('lobe-server:network-proxy');

export const NETWORK_PROXY_AUDIT_ACTIONS = B1_AUDIT_ACTIONS as typeof B1_AUDIT_ACTIONS &
  Record<keyof typeof B1_AUDIT_ACTIONS, AuditAction>;
export const NETWORK_PROXY_AUDIT_TARGET_TYPES =
  B1_AUDIT_TARGET_TYPES as typeof B1_AUDIT_TARGET_TYPES &
    Record<keyof typeof B1_AUDIT_TARGET_TYPES, AuditTargetType>;
export { NETWORK_PROXY_SETTINGS_ID };

export const NETWORK_PROXY_UPLOAD_PROCEDURE = 'admin.networkProxy.uploadArtifact';

/** Multipart envelope slack on top of the 64 MiB file cap (design §3.2). */
export const UPLOAD_CONTENT_LENGTH_SLACK_BYTES = 64 * 1024;

export interface NetworkProxySettingsRow {
  config: NetworkProxyConfig;
  desiredArtifacts: DesiredArtifacts;
  engineGeneration: number;
  revision: number;
  updatedAt: Date | null;
}

export interface EngineRuntimeLike {
  getLogs: () => string[];
  getState: () => {
    proxyUrl: string | null;
    state: NetworkProxyEngineState;
  };
  listNodes: () => Promise<ProxyNodeView[]>;
  refreshSubscriptionNow: (id: string) => Promise<void>;
  restart: () => Promise<void>;
  selectNode: (name: string) => Promise<void>;
  testGroupDelay: () => Promise<ProxyNodeView[]>;
  testNodeDelay: (name: string) => Promise<number | null>;
}

export interface ArtifactManagerLike {
  getStatus: () => Promise<ArtifactState[]>;
  installFromDownload: (
    kind: NetworkProxyArtifactKind,
    opts?: { proxyUrl?: string | null },
  ) => Promise<{ sha256: string; version: string }>;
  installFromStream: (
    kind: NetworkProxyArtifactKind,
    stream: NodeJS.ReadableStream,
    opts: { compressed: 'auto' | 'gzip' | 'none'; source: 'download' | 'upload' },
  ) => Promise<{ sha256: string; version: string }>;
}

export interface NetworkProxyRuntime {
  applyScopeOps: (config: NetworkProxyConfig, ops: EgressScopeOp[]) => NetworkProxyConfig;
  applyStaticProxyUpdate: (
    current: StaticProxyPersisted | undefined,
    update: StaticProxyUpdate | null,
  ) => Promise<StaticProxyPersisted | undefined>;
  artifactManager: ArtifactManagerLike;
  assertCanEnable: (config: NetworkProxyConfig) => void;
  /** Live status of the answering instance (shown even when its heartbeat row is missing). */
  buildLocalInstanceStatus: () => Promise<InstanceStatusUpsert>;
  bumpEngineGeneration: (
    db: LobeChatDatabase | Transaction,
    input: { expectedRevision: number; updatedBy: string },
  ) => Promise<NetworkProxySettingsRow>;
  createSubscriptionRecord: (
    db: LobeChatDatabase | Transaction,
    input: SubscriptionCreate,
    userId: string,
  ) => Promise<SubscriptionView>;
  deleteSubscriptionRecord: (db: LobeChatDatabase | Transaction, id: string) => Promise<void>;
  detectEnginePlatform: () => {
    arch: string;
    key: string | null;
    platform: string;
  };
  getDispatcherFor: ((proxyUrl: string) => unknown) | null;
  getEgressCounters: () => {
    fallbackScopes: EgressScopeId[];
  };
  getEngineRuntime: () => EngineRuntimeLike;
  getNetworkProxySettings: (db: LobeChatDatabase | Transaction) => Promise<NetworkProxySettingsRow>;
  getOutletHealth: () => {
    activeNode: string | null;
    activeNodeDelayMs: number | null;
    available: boolean;
    circuitOpen: boolean;
    kind: 'engine' | 'static';
    unavailableReason: string | null;
  };
  isLegacyGlobalProxyActive: () => boolean;
  listFreshInstanceStatuses: (
    db: LobeChatDatabase | Transaction,
    currentInstanceId: string,
  ) => Promise<InstanceStatusView[]>;
  listSubscriptionViews: (db: LobeChatDatabase | Transaction) => Promise<SubscriptionView[]>;
  peekNetworkProxySnapshot: () => { staticProxyUrl: string | null } | null;
  publishNetworkProxyInvalidation: (revision: number) => Promise<void>;
  redactSecrets: (text: string) => string;
  requestSubscriptionRefresh: (db: LobeChatDatabase | Transaction, id: string) => Promise<void>;
  setDesiredArtifacts: (
    db: LobeChatDatabase | Transaction,
    patch: DesiredArtifacts,
    input: { expectedRevision: number; updatedBy: string },
  ) => Promise<NetworkProxySettingsRow>;
  toNetworkProxyConfigView: (config: NetworkProxyConfig) => NetworkProxyConfigView;
  updateNetworkProxySettings: (
    db: LobeChatDatabase | Transaction,
    input: { config: NetworkProxyConfig; expectedRevision: number; updatedBy: string },
  ) => Promise<NetworkProxySettingsRow>;
  updateSubscriptionRecord: (
    db: LobeChatDatabase | Transaction,
    input: SubscriptionUpdate,
    userId: string,
  ) => Promise<SubscriptionView>;
}

let runtimeOverride: Partial<NetworkProxyRuntime> | null = null;
let loadedRuntime: NetworkProxyRuntime | null = null;

export const setNetworkProxyRuntimeForTests = (next: Partial<NetworkProxyRuntime> | null) => {
  runtimeOverride = next;
  loadedRuntime = null;
};

/**
 * Best-effort redactor kept for unit tests and as a last-resort fallback.
 */
export const redactSecretsFallback = (text: string): string =>
  text
    .replaceAll(/\/\/[^:/@\s]+:[^@/\s]+@/g, '//***:***@')
    .replaceAll(
      /([?&](?:token|key|apikey|api_key|sig|signature|password|passwd|secret|auth|access_token)=)[^&\s]*/gi,
      '$1***',
    )
    .replaceAll(/\b(?:Basic|Bearer)\s+\S+/gi, (match) => `${match.split(/\s+/)[0]} ***`)
    .replaceAll(/\bProxy-Authorization:\s*\S+/gi, 'Proxy-Authorization: ***')
    .replaceAll(
      /\b(?:ss|ssr|vmess|vless|trojan|hysteria2|hy2|tuic|anytls):\/\/\S+/gi,
      (url) => `${url.split('://')[0]}://***`,
    );

const asDb = (db: LobeChatDatabase | Transaction): LobeChatDatabase => db as LobeChatDatabase;

const loadNetworkProxyRuntime = async (): Promise<NetworkProxyRuntime> => ({
  applyScopeOps,
  applyStaticProxyUpdate,
  artifactManager,
  assertCanEnable,
  bumpEngineGeneration: async (db, input) =>
    new NetworkProxySettingsModel(asDb(db)).bumpEngineGeneration(input),
  createSubscriptionRecord: (db, input, userId) =>
    createSubscriptionRecord(asDb(db), input, userId),
  deleteSubscriptionRecord: (db, id) => deleteSubscriptionRecord(asDb(db), id),
  buildLocalInstanceStatus: () => buildLocalInstanceStatus(getEngineRuntime()),
  detectEnginePlatform,
  getDispatcherFor: getDispatcher,
  getEgressCounters,
  getEngineRuntime,
  getNetworkProxySettings: (db) => getNetworkProxySettings(asDb(db)),
  getOutletHealth,
  isLegacyGlobalProxyActive,
  listFreshInstanceStatuses: (db, instanceId) => listFreshInstanceStatuses(asDb(db), instanceId),
  listSubscriptionViews: (db) => listSubscriptionViews(asDb(db)),
  peekNetworkProxySnapshot,
  publishNetworkProxyInvalidation,
  redactSecrets,
  requestSubscriptionRefresh: (db, id) => requestSubscriptionRefresh(asDb(db), id),
  setDesiredArtifacts: async (db, patch, input) =>
    new NetworkProxySettingsModel(asDb(db)).setDesiredArtifacts(patch, input),
  toNetworkProxyConfigView,
  updateNetworkProxySettings: (db, input) => updateNetworkProxySettings(asDb(db), input),
  updateSubscriptionRecord: (db, input, userId) =>
    updateSubscriptionRecord(asDb(db), input, userId),
});

export const getNetworkProxyRuntime = async (): Promise<NetworkProxyRuntime> => {
  if (runtimeOverride) {
    return runtimeOverride as NetworkProxyRuntime;
  }
  loadedRuntime ??= await loadNetworkProxyRuntime();
  return loadedRuntime;
};

export const currentInstanceId = (): string => getPlatformInstanceId();

export const toSettingsOutput = (
  row: NetworkProxySettingsRow,
  runtime: Pick<NetworkProxyRuntime, 'isLegacyGlobalProxyActive' | 'toNetworkProxyConfigView'>,
): AdminNetworkProxySettingsOutput => ({
  config: runtime.toNetworkProxyConfigView(row.config),
  desiredArtifacts: row.desiredArtifacts,
  engineGeneration: row.engineGeneration,
  globalProxyActive: runtime.isLegacyGlobalProxyActive(),
  revision: row.revision,
});

export const toSettingsMutationOutput = (
  row: NetworkProxySettingsRow,
  runtime: Pick<NetworkProxyRuntime, 'isLegacyGlobalProxyActive' | 'toNetworkProxyConfigView'>,
  local: AdminNetworkProxyLocalOutcome,
): AdminNetworkProxySettingsMutationOutput => ({
  ...toSettingsOutput(row, runtime),
  local,
});

/** First 12 hex chars of sha256 — audit-safe stand-in for a node / label. */
export const hashNameForAudit = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 12);

export const sanitizeLocalError = (error: unknown, _redact: (text: string) => string): string =>
  resolveEngineIssueCode(error);

const sameStringArray = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameOutlet = (left: OutletConfig, right: OutletConfig): boolean =>
  left.kind === right.kind &&
  left.mode === right.mode &&
  left.latencyIntervalSec === right.latencyIntervalSec &&
  left.latencyTestUrl === right.latencyTestUrl &&
  left.toleranceMs === right.toleranceMs &&
  (left.manualNodeName ?? undefined) === (right.manualNodeName ?? undefined);

/**
 * Dangerous when the write can change where the whole site egresses
 * (`masterEnabled` / `outlet` / `staticProxy` / `ruleMode` / `bypassHosts`).
 */
export const isDangerousSettingsUpdate = (
  current: NetworkProxyConfig,
  update: NetworkProxyConfigUpdate,
): boolean => {
  if (current.masterEnabled !== update.masterEnabled) return true;
  if (current.ruleMode !== update.ruleMode) return true;
  if (!sameStringArray(current.bypassHosts, update.bypassHosts)) return true;
  if (!sameOutlet(current.outlet, update.outlet)) return true;

  if (update.staticProxy === null) return Boolean(current.staticProxy);
  if (!current.staticProxy) return true;
  if (update.staticProxy.password.action !== 'keep') return true;
  return (
    current.staticProxy.type !== update.staticProxy.type ||
    current.staticProxy.server !== update.staticProxy.server ||
    current.staticProxy.port !== update.staticProxy.port ||
    (current.staticProxy.username ?? undefined) !== (update.staticProxy.username ?? undefined)
  );
};

export const summarizeSettingsAfterDiff = (next: NetworkProxyConfig, revision: number) => ({
  bypassHostCount: next.bypassHosts.length,
  hasStaticProxy: Boolean(next.staticProxy),
  masterEnabled: next.masterEnabled,
  outletKind: next.outlet.kind,
  outletMode: next.outlet.mode,
  revision,
  ruleMode: next.ruleMode,
});

const countEnabled = (states: Record<string, { enabled: boolean }>): number =>
  Object.values(states).filter((state) => state.enabled).length;

export const summarizeScopesAfterDiff = (
  next: NetworkProxyConfig,
  opCount: number,
  revision: number,
) => ({
  featureEnabledCount: countEnabled(next.scopes.features),
  opCount,
  providerEnabledCount: countEnabled(next.scopes.providers),
  revision,
});

export const summarizeSubscriptionAfterDiff = (
  view: Pick<SubscriptionView, 'id' | 'kind' | 'name' | 'urlHost'>,
  redact: (text: string) => string = redactSecrets,
) => ({
  id: view.id,
  kind: view.kind,
  name: redact(view.name),
  urlHost: view.urlHost === null ? null : redact(view.urlHost),
});

export const desiredArtifactsPatchFor = (
  kind: NetworkProxyArtifactKind,
  requestedAt: string,
): DesiredArtifacts => {
  if (kind === 'engine') {
    return { engine: { requestedAt, version: NETWORK_PROXY_ENGINE_MANIFEST.version } };
  }
  const commit = NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit;
  return kind === 'geoip'
    ? { geoip: { commit, requestedAt } }
    : { geosite: { commit, requestedAt } };
};

export const installAuditActionFor = (kind: NetworkProxyArtifactKind) =>
  kind === 'engine'
    ? NETWORK_PROXY_AUDIT_ACTIONS.ENGINE_INSTALL
    : NETWORK_PROXY_AUDIT_ACTIONS.GEODATA_INSTALL;

export const buildArtifactStatusView = async (
  runtime: NetworkProxyRuntime,
  db: LobeChatDatabase,
) => {
  const detected = runtime.detectEnginePlatform();
  const key = detected.key;
  const asset =
    key && key in NETWORK_PROXY_ENGINE_MANIFEST.assets
      ? NETWORK_PROXY_ENGINE_MANIFEST.assets[
          key as keyof typeof NETWORK_PROXY_ENGINE_MANIFEST.assets
        ]
      : null;
  const instances = await runtime.listFreshInstanceStatuses(db, currentInstanceId());
  return {
    engine: {
      binSha256: asset?.binSha256 ?? null,
      expectedAsset: asset?.asset ?? null,
      platformKey: key,
      supported: Boolean(key),
      version: NETWORK_PROXY_ENGINE_MANIFEST.version,
    },
    geodata: {
      commit: NETWORK_PROXY_ENGINE_MANIFEST.geodata.commit,
      files: [
        NETWORK_PROXY_ENGINE_MANIFEST.geodata.files.geoip.file,
        NETWORK_PROXY_ENGINE_MANIFEST.geodata.files.geosite.file,
      ],
    },
    instances: instances.map((instance) => ({
      artifacts: instance.artifacts,
      instanceId: instance.instanceId,
      isCurrent: instance.isCurrent,
    })),
  };
};

export const runLocalArtifactInstall = async (
  runtime: NetworkProxyRuntime,
  kind: NetworkProxyArtifactKind,
  proxyUrl: string | null,
): Promise<AdminNetworkProxyLocalOutcome & { sha256: string | null; version: string | null }> => {
  try {
    const installed = await runtime.artifactManager.installFromDownload(kind, { proxyUrl });
    log('local artifact install finished %s', kind);
    return { error: null, ok: true, sha256: installed.sha256, version: installed.version };
  } catch (error: unknown) {
    const sanitized = sanitizeLocalError(error, runtime.redactSecrets);
    console.error('[admin.networkProxy] local artifact install failed', {
      errorClass: sanitized,
      kind,
    });
    return { error: sanitized, ok: false, sha256: null, version: null };
  }
};

export const runLocalEngineAction = async (
  label: string,
  action: () => Promise<void>,
  redact: (text: string) => string,
): Promise<AdminNetworkProxyLocalOutcome> => {
  try {
    await action();
    return { error: null, ok: true };
  } catch (error: unknown) {
    const sanitized = sanitizeLocalError(error, redact);
    console.error(`[admin.networkProxy] ${label} failed`, { errorClass: sanitized });
    return { error: sanitized, ok: false };
  }
};

/** Post-commit audit: never throw — a failed follow-up must not 500 a committed write. */
export const appendPostCommitAudit = async (
  ctx: { serverDB: LobeChatDatabase; userId: string },
  input: {
    action: (typeof NETWORK_PROXY_AUDIT_ACTIONS)[keyof typeof NETWORK_PROXY_AUDIT_ACTIONS];
    afterDiff: Record<string, unknown>;
    configRevision?: number;
    result?: 'failure' | 'success';
    targetId: string;
    targetType: (typeof NETWORK_PROXY_AUDIT_TARGET_TYPES)[keyof typeof NETWORK_PROXY_AUDIT_TARGET_TYPES];
  },
): Promise<void> => {
  try {
    const { PlatformAuditService } = await import('../../services/platformAudit');
    await new PlatformAuditService(ctx.serverDB).append({
      action: input.action,
      actorUserId: ctx.userId,
      afterDiff: input.afterDiff,
      ...(input.configRevision === undefined ? {} : { configRevision: input.configRevision }),
      result: input.result ?? 'success',
      targetId: input.targetId,
      targetType: input.targetType,
    });
  } catch (auditError: unknown) {
    console.error('[admin.networkProxy] post-commit audit failed', {
      action: input.action,
      errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
    });
  }
};

export const appendInstallCompletionAudit = async (
  ctx: { serverDB: LobeChatDatabase; userId: string },
  input: {
    kind: NetworkProxyArtifactKind;
    local: AdminNetworkProxyLocalOutcome & { sha256: string | null; version: string | null };
    revision: number;
  },
) =>
  appendPostCommitAudit(ctx, {
    action: installAuditActionFor(input.kind),
    afterDiff: {
      kind: input.kind,
      localOutcome: { error: input.local.error, ok: input.local.ok },
      revision: input.revision,
      sha256: input.local.sha256,
      source: 'download',
      version: input.local.version,
    },
    configRevision: input.revision,
    result: input.local.ok ? 'success' : 'failure',
    targetId: input.kind,
    targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.ENGINE,
  });

const createInlineDispatcher = (proxyUrl: string): ProxyAgent => new ProxyAgent({ uri: proxyUrl });

export const testOutletConnectivity = async (
  runtime: NetworkProxyRuntime,
  latencyTestUrl: string,
): Promise<{
  egressIp: string | null;
  error: string | null;
  latencyMs: number | null;
  ok: boolean;
}> => {
  const settingsKind = (await Promise.resolve(runtime.getOutletHealth())).kind;
  const engineState = runtime.getEngineRuntime().getState();
  const snapshot = runtime.peekNetworkProxySnapshot();
  const proxyUrl =
    settingsKind === 'static' ? (snapshot?.staticProxyUrl ?? null) : engineState.proxyUrl;

  if (!proxyUrl) {
    return { egressIp: null, error: 'outlet_unavailable', latencyMs: null, ok: false };
  }

  const dispatcher = runtime.getDispatcherFor?.(proxyUrl) ?? createInlineDispatcher(proxyUrl);
  const startedAt = Date.now();
  try {
    const response = await undiciFetch(latencyTestUrl, {
      dispatcher: dispatcher as never,
      method: 'GET',
      signal: AbortSignal.timeout(NETWORK_PROXY_LIMITS.LATENCY_TEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    let egressIp: string | null = null;
    try {
      const ipResponse = await undiciFetch('https://api.ip.sb/ip', {
        dispatcher: dispatcher as never,
        method: 'GET',
        signal: AbortSignal.timeout(NETWORK_PROXY_LIMITS.LATENCY_TEST_TIMEOUT_MS),
      });
      if (ipResponse.ok) {
        const text = (await ipResponse.text()).trim();
        egressIp = text.length > 0 && text.length <= 64 ? text : null;
      }
    } catch {
      egressIp = null;
    }
    return {
      egressIp,
      error: response.ok ? null : runtime.redactSecrets(`http_${response.status}`),
      latencyMs,
      ok: response.ok,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'outlet_request_failed';
    return {
      egressIp: null,
      error: runtime.redactSecrets(message),
      latencyMs: Date.now() - startedAt,
      ok: false,
    };
  }
};

export const mapNetworkProxyError = (error: unknown): never => {
  if (error instanceof TRPCError) throw error;
  if (error instanceof PlatformRevisionConflictError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      details: error.details as Record<string, string | number | boolean | null> | undefined,
    });
  }
  if (error instanceof z.ZodError) {
    return throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { issueCount: error.issues.length },
    });
  }

  const body = getEnterpriseErrorBody(error);
  if (body?.code) {
    throw error;
  }

  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (code && code in PLATFORM_ERROR_CODES) {
      return throwEnterpriseError({
        code: code as keyof typeof PLATFORM_ERROR_CODES,
        details:
          'details' in error
            ? ((error as { details?: Record<string, string | number | boolean | null> }).details ??
              undefined)
            : undefined,
      });
    }
  }

  if (error instanceof Error) {
    const message = error.message;
    if (message in PLATFORM_ERROR_CODES) {
      return throwEnterpriseError({
        code: message as keyof typeof PLATFORM_ERROR_CODES,
      });
    }
  }

  console.error('[admin.networkProxy] unexpected operation failure', {
    errorClass: error instanceof Error ? error.name : 'UnknownError',
  });
  return throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: { reason: 'operation_failed' },
    httpCode: 'INTERNAL_SERVER_ERROR',
  });
};

export const parseArtifactKind = (value: string | null): NetworkProxyArtifactKind | null => {
  if (value === 'engine' || value === 'geoip' || value === 'geosite') return value;
  return null;
};

export type UploadContentLengthDecision =
  { ok: true } | { code: string; ok: false; status: 411 | 413 };

/**
 * Reject unbounded or oversized bodies before any read. Content-Length is
 * required; chunked Transfer-Encoding and a missing/unparseable length are 411.
 */
export const assertUploadContentLength = (request: Request): UploadContentLengthDecision => {
  const transferEncoding = request.headers.get('transfer-encoding') ?? '';
  const isChunked = transferEncoding
    .toLowerCase()
    .split(',')
    .some((part) => part.trim() === 'chunked');
  const raw = request.headers.get('content-length');
  if (isChunked || raw === null || raw.trim() === '') {
    return { code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT, ok: false, status: 411 };
  }
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0) {
    return { code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT, ok: false, status: 411 };
  }
  if (
    length >
    NETWORK_PROXY_LIMITS.UPLOAD_MAX_COMPRESSED_BYTES + UPLOAD_CONTENT_LENGTH_SLACK_BYTES
  ) {
    return { code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT, ok: false, status: 413 };
  }
  return { ok: true };
};

export const rejectOversizedUpload = (request: Request): boolean => {
  const decision = assertUploadContentLength(request);
  return !decision.ok && decision.status === 413;
};

const fileToNodeStream = (file: File): NodeJS.ReadableStream =>
  Readable.fromWeb(file.stream() as NodeWebReadableStream);

export interface ArtifactUploadResult {
  sha256: string;
  version: string;
}

export const handleNetworkProxyArtifactUpload = async (
  request: Request,
  ctx: { serverDB: LobeChatDatabase; userId: string },
): Promise<Response> => {
  const rawKind = new URL(request.url).searchParams.get('kind');
  const kind = parseArtifactKind(rawKind);
  const action = installAuditActionFor(kind ?? 'engine');
  // Never persist a raw `kind` query value — it is operator-controlled.
  const auditKind = kind ?? 'invalid';

  const fail = async (params: { code: string; errorClass: string; status: number }) => {
    await appendUploadAudit(ctx, {
      action,
      afterDiff: { error: params.errorClass, kind: auditKind, source: 'upload' },
      result: 'failure',
    }).catch((auditError: unknown) => {
      console.error('[admin.networkProxy] upload failure audit failed', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    });
    return jsonCode(params.code, params.status);
  };

  try {
    const lengthDecision = assertUploadContentLength(request);
    if (!lengthDecision.ok) {
      return await fail({
        code: lengthDecision.code,
        errorClass: lengthDecision.status === 413 ? 'payload_too_large' : 'length_required',
        status: lengthDecision.status,
      });
    }

    if (!kind) {
      return await fail({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        errorClass: 'invalid_kind',
        status: 400,
      });
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return await fail({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        errorClass: 'multipart_parse',
        status: 400,
      });
    }

    const file = formData.get('file');
    if (!(file instanceof File)) {
      return await fail({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        errorClass: 'missing_file',
        status: 400,
      });
    }
    if (file.size > NETWORK_PROXY_LIMITS.UPLOAD_MAX_COMPRESSED_BYTES) {
      return await fail({
        code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
        errorClass: 'payload_too_large',
        status: 413,
      });
    }

    const runtime = await getNetworkProxyRuntime();
    const installed = await runtime.artifactManager.installFromStream(
      kind,
      fileToNodeStream(file),
      {
        compressed: 'auto',
        source: 'upload',
      },
    );

    await appendUploadAudit(ctx, {
      action,
      afterDiff: { kind, sha256: installed.sha256, source: 'upload', version: installed.version },
      result: 'success',
    });

    return Response.json(
      { ok: true, sha256: installed.sha256, version: installed.version },
      { status: 200 },
    );
  } catch (error) {
    const code = resolveUploadErrorCode(error);
    return await fail({
      code,
      errorClass: sanitizeLocalError(error, redactSecrets),
      status: statusForUploadCode(code),
    });
  }
};

const resolveUploadErrorCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  if (error instanceof Error && error.message in PLATFORM_ERROR_CODES) return error.message;
  return PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ENGINE_ERROR;
};

const statusForUploadCode = (code: string): number => {
  if (code === PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH) return 400;
  if (code === PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNSUPPORTED_PLATFORM) return 400;
  if (code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT) return 400;
  if (code === PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ENGINE_NOT_INSTALLED) return 409;
  return 500;
};

const jsonCode = (code: string, status: number) => Response.json({ code }, { status });

const appendUploadAudit = async (
  ctx: { serverDB: LobeChatDatabase; userId: string },
  input: {
    action: (typeof NETWORK_PROXY_AUDIT_ACTIONS)[keyof typeof NETWORK_PROXY_AUDIT_ACTIONS];
    afterDiff: Record<string, unknown>;
    result: 'failure' | 'success';
  },
) => {
  const { PlatformAuditService } = await import('../../services/platformAudit');
  await new PlatformAuditService(ctx.serverDB).append({
    action: input.action,
    actorUserId: ctx.userId,
    afterDiff: input.afterDiff,
    result: input.result,
    targetId: input.action === NETWORK_PROXY_AUDIT_ACTIONS.ENGINE_INSTALL ? 'engine' : 'geodata',
    targetType: NETWORK_PROXY_AUDIT_TARGET_TYPES.ENGINE,
  });
};

/**
 * The answering instance always appears in status output — even before its heartbeat row
 * exists (or when heartbeats are disabled), so the admin never sees "no instances" while
 * talking to a live server. DB rows win when present (they carry the real heartbeat time).
 */
export const withLocalInstanceStatus = async (
  runtime: Pick<NetworkProxyRuntime, 'buildLocalInstanceStatus'>,
  instances: InstanceStatusView[],
  instanceId: string,
): Promise<InstanceStatusView[]> => {
  if (instances.some((instance) => instance.instanceId === instanceId)) return instances;
  try {
    const local = await runtime.buildLocalInstanceStatus();
    const now = new Date().toISOString();
    return [
      {
        activeNode: local.activeNode,
        aliveNodeCount: local.aliveNodeCount,
        appliedRevision: local.appliedRevision,
        arch: local.arch,
        artifacts: local.artifacts,
        engineState: local.engineState,
        engineVersion: local.engineVersion,
        fallbackCount: local.fallbackCount,
        healing: local.healing,
        instanceId,
        isCurrent: true,
        lastHeartbeatAt: now,
        lastIssue: local.lastIssue,
        platform: local.platform,
        proxiedCount: local.proxiedCount,
        updatedAt: now,
      },
      ...instances,
    ];
  } catch {
    return instances;
  }
};
