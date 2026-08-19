/**
 * admin.networkProxy helpers: audit tokens, B1/B2/B3 runtime seam, CAS summaries,
 * artifact upload, and outlet connectivity (never logs URLs / passwords / payloads).
 */
import debug from 'debug';

import { NETWORK_PROXY_ENGINE_MANIFEST } from '@/const/platform/networkProxy';
import type { LobeChatDatabase } from '@/database/type';
import type { InstanceStatusView, NetworkProxyArtifactKind } from '@/types/platform/networkProxy';

import type { AdminNetworkProxyLocalOutcome } from '../../contracts/adminNetworkProxy';
import type { AuditAction, AuditTargetType } from '../../services/audit/auditActionCatalog';
import {
  NETWORK_PROXY_AUDIT_ACTIONS as B1_AUDIT_ACTIONS,
  NETWORK_PROXY_AUDIT_TARGET_TYPES as B1_AUDIT_TARGET_TYPES,
  NETWORK_PROXY_SETTINGS_ID,
} from '../../services/networkProxy/constants';
import type { InstanceStatusUpsert } from '../../services/networkProxy/instanceStatusService';
import { sanitizeLocalError } from './networkProxyErrors';
import type { NetworkProxyRuntime } from './networkProxyRuntime';
import { currentInstanceId } from './networkProxyRuntime';
import { installAuditActionFor } from './networkProxySettingsDiff';

export const NETWORK_PROXY_AUDIT_ACTIONS = B1_AUDIT_ACTIONS as typeof B1_AUDIT_ACTIONS &
  Record<keyof typeof B1_AUDIT_ACTIONS, AuditAction>;
export const NETWORK_PROXY_AUDIT_TARGET_TYPES =
  B1_AUDIT_TARGET_TYPES as typeof B1_AUDIT_TARGET_TYPES &
    Record<keyof typeof B1_AUDIT_TARGET_TYPES, AuditTargetType>;
export { NETWORK_PROXY_SETTINGS_ID };

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

const log = debug('lobe-server:network-proxy');

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
  const instanceId = currentInstanceId();
  const instances = await withLocalInstanceStatus(
    runtime,
    await runtime.listFreshInstanceStatuses(db, instanceId),
    instanceId,
  );
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
    await runtime.reportLocalInstanceStatus?.().catch(() => false);
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

/**
 * Overlay live local engine/artifact fields onto a status row. Heartbeat time,
 * updatedAt, and egress counters stay on the persisted row.
 */
export const overlayLiveLocalInstanceStatus = (
  row: InstanceStatusView,
  local: InstanceStatusUpsert,
): InstanceStatusView => ({
  ...row,
  activeNode: local.activeNode,
  aliveNodeCount: local.aliveNodeCount,
  appliedRevision: local.appliedRevision,
  artifacts: local.artifacts,
  engineState: local.engineState,
  engineVersion: local.engineVersion,
  healing: local.healing,
  lastIssue: local.lastIssue,
});

/**
 * The answering instance always appears in status output — even before its heartbeat row
 * exists (or when heartbeats are disabled). When a heartbeat row is present, live local
 * engine/artifact state is overlaid so a just-finished install is visible immediately.
 */
export const withLocalInstanceStatus = async (
  runtime: Pick<NetworkProxyRuntime, 'buildLocalInstanceStatus'>,
  instances: InstanceStatusView[],
  instanceId: string,
): Promise<InstanceStatusView[]> => {
  let local: InstanceStatusUpsert | null = null;
  try {
    local = await runtime.buildLocalInstanceStatus();
  } catch {
    local = null;
  }

  if (instances.some((instance) => instance.instanceId === instanceId)) {
    if (!local) return instances;
    return instances.map((instance) =>
      instance.instanceId === instanceId
        ? overlayLiveLocalInstanceStatus({ ...instance, isCurrent: true }, local)
        : instance,
    );
  }

  if (!local) return instances;
  const now = new Date().toISOString();
  return [
    overlayLiveLocalInstanceStatus(
      {
        activeNode: null,
        aliveNodeCount: null,
        appliedRevision: null,
        arch: local.arch,
        artifacts: [],
        engineState: local.engineState,
        engineVersion: null,
        fallbackCount: local.fallbackCount,
        healing: null,
        instanceId,
        isCurrent: true,
        lastHeartbeatAt: now,
        lastIssue: null,
        platform: local.platform,
        proxiedCount: local.proxiedCount,
        updatedAt: now,
      },
      local,
    ),
    ...instances,
  ];
};

export type {
  ArtifactUploadResult,
  UploadContentLengthDecision,
} from './networkProxyArtifactUpload';
export {
  assertUploadContentLength,
  handleNetworkProxyArtifactUpload,
  NETWORK_PROXY_UPLOAD_PROCEDURE,
  parseArtifactKind,
  rejectOversizedUpload,
  UPLOAD_CONTENT_LENGTH_SLACK_BYTES,
} from './networkProxyArtifactUpload';
export { testOutletConnectivity } from './networkProxyConnectivity';
export { mapNetworkProxyError, sanitizeLocalError } from './networkProxyErrors';
export type {
  ArtifactManagerLike,
  EngineRuntimeLike,
  NetworkProxyRuntime,
  NetworkProxySettingsRow,
} from './networkProxyRuntime';
export {
  currentInstanceId,
  getNetworkProxyRuntime,
  setNetworkProxyRuntimeForTests,
} from './networkProxyRuntime';
export {
  desiredArtifactsPatchFor,
  hashNameForAudit,
  installAuditActionFor,
  isDangerousSettingsUpdate,
  summarizeScopesAfterDiff,
  summarizeSettingsAfterDiff,
  summarizeSubscriptionAfterDiff,
  toSettingsMutationOutput,
  toSettingsOutput,
} from './networkProxySettingsDiff';
