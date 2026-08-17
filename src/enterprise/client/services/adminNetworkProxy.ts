import { lambdaClient } from '@/libs/trpc/client';
import type {
  ArtifactStatusView,
  DesiredArtifacts,
  EgressScopeOp,
  NetworkProxyArtifactKind,
  NetworkProxyConfigUpdate,
  NetworkProxyConfigView,
  NetworkProxyEngineState,
  NetworkProxyStatusView,
  ProxyNodeView,
  SubscriptionCreate,
  SubscriptionUpdate,
  SubscriptionView,
} from '@/types/platform/networkProxy';

/** `admin.networkProxy.getSettings` / every settings-writing mutation returns this bundle. */
export interface AdminNetworkProxySettings {
  config: NetworkProxyConfigView;
  desiredArtifacts: DesiredArtifacts;
  engineGeneration: number;
  /** `PROXY_URL` (legacy proxychains) is set — the master switch cannot be turned on. */
  globalProxyActive: boolean;
  revision: number;
}

/**
 * Post-commit outcome of the *answering* instance for a write that also kicks it
 * (install / restart / selectNode). The database write already succeeded — `ok: false` means the
 * desired state is stored but this instance could not act on it yet (B4 contract
 * `AdminNetworkProxySettingsMutationOutput`). `error` is already redacted server-side.
 */
export interface AdminNetworkProxyLocalOutcome {
  error: string | null;
  ok: boolean;
}

export interface AdminNetworkProxySettingsMutation extends AdminNetworkProxySettings {
  local: AdminNetworkProxyLocalOutcome;
}

export interface AdminNetworkProxyNodeList {
  /** Which application instance answered — node lists are per-instance. */
  instanceId: string;
  nodes: ProxyNodeView[];
}

export interface AdminNetworkProxyNodes extends AdminNetworkProxyNodeList {
  engineState: NetworkProxyEngineState;
}

export interface AdminNetworkProxyEngineLogs {
  instanceId: string;
  lines: string[];
}

export interface AdminNetworkProxyConnectivity {
  egressIp: string | null;
  error: string | null;
  latencyMs: number | null;
  ok: boolean;
}

export interface AdminNetworkProxyUploadResult {
  ok: true;
  sha256: string;
  version: string;
}

export interface AdminNetworkProxyUploadInput {
  file: File;
  kind: NetworkProxyArtifactKind;
  /** 0–1 transfer progress; only fires while the browser reports a computable length. */
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/**
 * Contract-derived client boundary for `admin.networkProxy.*` (design §5) plus the one
 * multipart route that cannot go through tRPC.
 *
 * Kept as an interface so the tab can be rendered in tests against a stub without touching
 * the tRPC client, and so every caller sees the exact DTOs from `@/types/platform/networkProxy`.
 */
export interface AdminNetworkProxyService {
  createSubscription: (input: SubscriptionCreate) => Promise<SubscriptionView>;
  deleteSubscription: (input: { id: string; reason?: string }) => Promise<{ ok: true }>;
  getArtifactStatus: () => Promise<ArtifactStatusView>;
  getEngineLogs: () => Promise<AdminNetworkProxyEngineLogs>;
  getSettings: () => Promise<AdminNetworkProxySettings>;
  getStatus: () => Promise<NetworkProxyStatusView>;
  installArtifact: (input: {
    expectedRevision: number;
    kind: NetworkProxyArtifactKind;
  }) => Promise<AdminNetworkProxySettingsMutation>;
  listNodes: () => Promise<AdminNetworkProxyNodes>;
  listSubscriptions: () => Promise<{ items: SubscriptionView[] }>;
  refreshSubscription: (input: { id: string }) => Promise<SubscriptionView>;
  restartEngine: (input: {
    expectedRevision: number;
  }) => Promise<AdminNetworkProxySettingsMutation>;
  selectNode: (input: {
    expectedRevision: number;
    nodeName: string;
  }) => Promise<AdminNetworkProxySettingsMutation>;
  testConnectivity: () => Promise<AdminNetworkProxyConnectivity>;
  /** A latency test answers with fresh delays only — the engine state comes from `getStatus`. */
  testLatency: (input: { nodeName?: string }) => Promise<AdminNetworkProxyNodeList>;
  updateScopes: (input: {
    expectedRevision: number;
    ops: EgressScopeOp[];
  }) => Promise<AdminNetworkProxySettings>;
  updateSettings: (input: {
    config: NetworkProxyConfigUpdate;
    expectedRevision: number;
    reason?: string;
  }) => Promise<AdminNetworkProxySettings>;
  updateSubscription: (input: SubscriptionUpdate) => Promise<SubscriptionView>;
  /** Manual artifact install — multipart, guarded by `withAdminWebapiGuard` (design §5). */
  uploadArtifact: (input: AdminNetworkProxyUploadInput) => Promise<AdminNetworkProxyUploadResult>;
}

export const NETWORK_PROXY_ARTIFACT_UPLOAD_PATH = '/webapi/admin/network-proxy/artifact';

/** Shape the upload route returns on failure: `{ code: 'PLATFORM_NETWORK_PROXY_...' }`. */
const readErrorCode = (raw: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'code' in parsed) {
      const code = (parsed as { code?: unknown }).code;
      return typeof code === 'string' ? code : null;
    }
  } catch {
    // Non-JSON body (proxy error page, 413 from the edge, …) — fall through to a generic error.
  }
  return null;
};

/**
 * Reject with an error `withAdminReauthRetry` / `mapEnterpriseError` can read: both look at
 * `message` and `data.code`, so carry the server code in both places.
 */
const uploadError = (code: string): Error =>
  Object.assign(new Error(code), { data: { code, errorData: { code } } });

/**
 * The same headers the tRPC lambda client sends (`packages/trpc/src/client/lambda.ts`): the
 * OIDC / auth header plus whatever the business layer contributes (workspace context in Cloud).
 * Without these an administrator authenticated by header rather than by cookie can call every
 * tRPC procedure but is rejected by this route.
 *
 * `Content-Type` is deliberately never set — the browser must add the multipart boundary.
 */
export const buildAdminUploadHeaders = async (): Promise<Record<string, string>> => {
  const { createHeaderWithAuth } = await import('@/services/_auth');
  const headers = { ...((await createHeaderWithAuth()) as Record<string, string>) };
  const { getBusinessTrpcHeaders } = await import('@/business/client/trpc-headers');
  Object.assign(headers, await getBusinessTrpcHeaders());
  delete headers['Content-Type'];
  delete headers['content-type'];
  return headers;
};

const uploadArtifactViaXhr = async ({
  file,
  kind,
  onProgress,
  signal,
}: AdminNetworkProxyUploadInput): Promise<AdminNetworkProxyUploadResult> => {
  const headers = await buildAdminUploadHeaders();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(uploadError('ADMIN_UPLOAD_ABORTED'));
      return;
    }
    const form = new FormData();
    form.append('file', file, file.name);

    // XHR (not fetch) because upload progress is the only honest way to show a three-state
    // long task for a 45 MB artifact — `fetch` has no upload progress event.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${NETWORK_PROXY_ARTIFACT_UPLOAD_PATH}?kind=${encodeURIComponent(kind)}`);
    // Cookies carry the Better Auth session (and its reauth freshness) for cookie-auth admins.
    xhr.withCredentials = true;
    xhr.responseType = 'text';
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string' && value.length > 0) xhr.setRequestHeader(name, value);
    }

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable || event.total <= 0) return;
        onProgress(Math.min(1, event.loaded / event.total));
      });
    }

    xhr.addEventListener('abort', () => {
      cleanup();
      reject(uploadError('ADMIN_UPLOAD_ABORTED'));
    });
    xhr.addEventListener('error', () => {
      cleanup();
      reject(uploadError('ADMIN_UPLOAD_NETWORK_ERROR'));
    });
    xhr.addEventListener('load', () => {
      cleanup();
      const body = String(xhr.responseText ?? '');
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(body) as AdminNetworkProxyUploadResult;
          if (parsed?.ok) {
            resolve(parsed);
            return;
          }
        } catch {
          // fall through
        }
        reject(uploadError('ADMIN_UPLOAD_INVALID_RESPONSE'));
        return;
      }
      reject(uploadError(readErrorCode(body) ?? `ADMIN_UPLOAD_FAILED_${xhr.status}`));
    });

    xhr.send(form);
  });
};

class AdminNetworkProxyServiceImpl implements AdminNetworkProxyService {
  createSubscription = (input: SubscriptionCreate) =>
    lambdaClient.admin.networkProxy.createSubscription.mutate(input);

  deleteSubscription = (input: { id: string; reason?: string }) =>
    lambdaClient.admin.networkProxy.deleteSubscription.mutate(input);

  getArtifactStatus = () => lambdaClient.admin.networkProxy.getArtifactStatus.query();

  getEngineLogs = () => lambdaClient.admin.networkProxy.getEngineLogs.query();

  getSettings = () => lambdaClient.admin.networkProxy.getSettings.query();

  getStatus = () => lambdaClient.admin.networkProxy.getStatus.query();

  installArtifact = (input: { expectedRevision: number; kind: NetworkProxyArtifactKind }) =>
    lambdaClient.admin.networkProxy.installArtifact.mutate(input);

  listNodes = () => lambdaClient.admin.networkProxy.listNodes.query();

  listSubscriptions = () => lambdaClient.admin.networkProxy.listSubscriptions.query();

  refreshSubscription = (input: { id: string }) =>
    lambdaClient.admin.networkProxy.refreshSubscription.mutate(input);

  restartEngine = (input: { expectedRevision: number }) =>
    lambdaClient.admin.networkProxy.restartEngine.mutate(input);

  selectNode = (input: { expectedRevision: number; nodeName: string }) =>
    lambdaClient.admin.networkProxy.selectNode.mutate(input);

  testConnectivity = () => lambdaClient.admin.networkProxy.testConnectivity.mutate({});

  testLatency = (input: { nodeName?: string }) =>
    lambdaClient.admin.networkProxy.testLatency.mutate(input);

  updateScopes = (input: { expectedRevision: number; ops: EgressScopeOp[] }) =>
    lambdaClient.admin.networkProxy.updateScopes.mutate(input);

  updateSettings = (input: {
    config: NetworkProxyConfigUpdate;
    expectedRevision: number;
    reason?: string;
  }) => lambdaClient.admin.networkProxy.updateSettings.mutate(input);

  updateSubscription = (input: SubscriptionUpdate) =>
    lambdaClient.admin.networkProxy.updateSubscription.mutate(input);

  uploadArtifact = (input: AdminNetworkProxyUploadInput) => uploadArtifactViaXhr(input);
}

export const adminNetworkProxyService: AdminNetworkProxyService =
  new AdminNetworkProxyServiceImpl();
