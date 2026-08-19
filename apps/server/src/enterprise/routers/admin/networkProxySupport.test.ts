// @vitest-environment node
import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import { PlatformRevisionConflictError } from '@/database/models/platform/errors';
import type { LobeChatDatabase } from '@/database/type';
import type { NetworkProxyConfigUpdate } from '@/types/platform/networkProxy';
import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import {
  assertUploadContentLength,
  handleNetworkProxyArtifactUpload,
  hashNameForAudit,
  isDangerousSettingsUpdate,
  mapNetworkProxyError,
  redactSecretsFallback,
  rejectOversizedUpload,
  runLocalArtifactInstall,
  sanitizeLocalError,
  setNetworkProxyRuntimeForTests,
  testOutletConnectivity,
  withLocalInstanceStatus,
} from './networkProxySupport';

const appendSpy = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const ProxyAgentMock = vi.hoisted(() => vi.fn());

vi.mock('../../services/platformAudit', () => ({
  PlatformAuditService: class {
    append = appendSpy;
  },
}));

vi.mock('undici', () => ({
  fetch: fetchMock,
  ProxyAgent: class {
    constructor(opts: { uri: string }) {
      ProxyAgentMock(opts);
    }
  },
}));

describe('isDangerousSettingsUpdate', () => {
  const base = createDefaultNetworkProxyConfig();
  const updateOf = (patch: Partial<NetworkProxyConfigUpdate> = {}): NetworkProxyConfigUpdate => ({
    bypassHosts: base.bypassHosts,
    downloadViaStaticProxy: base.downloadViaStaticProxy,
    engineLogLevel: base.engineLogLevel,
    masterEnabled: base.masterEnabled,
    outlet: base.outlet,
    ruleMode: base.ruleMode,
    staticProxy: null,
    subscriptionUpdateViaOutlet: base.subscriptionUpdateViaOutlet,
    ...patch,
  });

  it('treats masterEnabled / outlet / ruleMode / bypassHosts as dangerous', () => {
    expect(isDangerousSettingsUpdate(base, updateOf({ masterEnabled: true }))).toBe(true);
    expect(isDangerousSettingsUpdate(base, updateOf({ ruleMode: 'smart' }))).toBe(true);
    expect(isDangerousSettingsUpdate(base, updateOf({ bypassHosts: ['example.com'] }))).toBe(true);
    expect(
      isDangerousSettingsUpdate(base, updateOf({ outlet: { ...base.outlet, kind: 'static' } })),
    ).toBe(true);
  });

  it('treats engineLogLevel-only edits as regular', () => {
    expect(isDangerousSettingsUpdate(base, updateOf({ engineLogLevel: 'info' }))).toBe(false);
  });
});

describe('redactSecretsFallback', () => {
  it('strips userinfo and share-link payloads', () => {
    expect(redactSecretsFallback('http://aihub:secret@127.0.0.1:1')).toContain('***');
    expect(redactSecretsFallback('ss://abc@host')).toBe('ss://***');
    expect(redactSecretsFallback('https://x.example/sub?token=abc')).toContain('token=***');
  });
});

describe('assertUploadContentLength', () => {
  it('requires Content-Length and rejects chunked bodies with 411', () => {
    const missing = assertUploadContentLength(
      new Request('https://example.com', { method: 'POST' }),
    );
    const chunked = assertUploadContentLength(
      new Request('https://example.com', {
        headers: { 'transfer-encoding': 'chunked' },
        method: 'POST',
      }),
    );
    expect(missing).toMatchObject({ ok: false, status: 411 });
    expect(chunked).toMatchObject({ ok: false, status: 411 });
  });

  it('rejects when content-length exceeds the compressed cap plus 64 KiB', () => {
    const over = new Request('https://example.com', {
      headers: {
        'content-length': String(NETWORK_PROXY_LIMITS.UPLOAD_MAX_COMPRESSED_BYTES + 64 * 1024 + 1),
      },
    });
    const under = new Request('https://example.com', {
      headers: { 'content-length': String(1024) },
    });
    expect(assertUploadContentLength(over)).toEqual({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      ok: false,
      status: 413,
    });
    expect(assertUploadContentLength(under)).toEqual({ ok: true });
    expect(rejectOversizedUpload(over)).toBe(true);
    expect(rejectOversizedUpload(under)).toBe(false);
  });
});

describe('hashNameForAudit', () => {
  it('returns the first 12 hex chars of sha256', () => {
    expect(hashNameForAudit('node-a')).toMatch(/^[a-f0-9]{12}$/);
    expect(hashNameForAudit('node-a')).toBe(hashNameForAudit('node-a'));
    expect(hashNameForAudit('node-a')).not.toBe(hashNameForAudit('node-b'));
  });
});

describe('sanitizeLocalError', () => {
  const redact = (text: string) => `redacted:${text}`;

  it('maps TimeoutError to health_timeout', () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    expect(sanitizeLocalError(error, redact)).toBe('health_timeout');
  });

  it('maps NetworkProxyEngineError / enterprise codes to issue codes', async () => {
    const { NetworkProxyEngineError } = await import('../../services/networkProxy/engine/errors');
    expect(
      sanitizeLocalError(
        new NetworkProxyEngineError(PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH),
        redact,
      ),
    ).toBe('artifact_mismatch');
    expect(
      sanitizeLocalError(
        new NetworkProxyEngineError(
          PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ENGINE_NOT_INSTALLED,
        ),
        redact,
      ),
    ).toBe('artifact_missing');
    expect(
      sanitizeLocalError(
        new NetworkProxyEngineError(
          PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNSUPPORTED_PLATFORM,
        ),
        redact,
      ),
    ).toBe('unsupported_platform');
  });

  it('returns unknown for unstructured errors and never a raw message', () => {
    expect(sanitizeLocalError(new Error('The operation was aborted due to timeout'), redact)).toBe(
      'unknown',
    );
    expect(sanitizeLocalError('nope', redact)).toBe('unknown');
  });
});

describe('withLocalInstanceStatus', () => {
  it('synthesizes lastIssue and healing when the heartbeat row is missing', async () => {
    const lastIssue = {
      at: '2026-08-17T00:00:00.000Z',
      code: 'health_timeout' as const,
      detail: 'aborted',
    };
    const healing = { attempt: 1, nextAttemptAt: '2026-08-17T00:00:30.000Z' };
    const rows = await withLocalInstanceStatus(
      {
        buildLocalInstanceStatus: async () => ({
          activeNode: null,
          aliveNodeCount: null,
          appliedEngineGeneration: null,
          appliedRevision: null,
          arch: 'arm64',
          artifacts: [],
          engineState: 'error',
          engineVersion: null,
          fallbackCount: 0,
          healing,
          instanceId: 'pinst_local',
          lastIssue,
          platform: 'darwin',
          proxiedCount: 0,
        }),
      },
      [],
      'pinst_local',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastIssue).toEqual(lastIssue);
    expect(rows[0]?.healing).toEqual(healing);
    expect(rows[0]?.isCurrent).toBe(true);
    expect(rows[0]).not.toHaveProperty('lastError');
  });

  it('overlays live local state onto an existing heartbeat row', async () => {
    const heartbeatAt = '2026-08-17T00:00:00.000Z';
    const rows = await withLocalInstanceStatus(
      {
        buildLocalInstanceStatus: async () => ({
          activeNode: 'node-live',
          aliveNodeCount: 3,
          appliedEngineGeneration: 2,
          appliedRevision: 9,
          arch: 'arm64',
          artifacts: [
            {
              installed: true,
              kind: 'geoip' as const,
              source: 'download' as const,
              version: 'abc',
            },
          ],
          engineState: 'running',
          engineVersion: 'v1.19.30',
          fallbackCount: 99,
          healing: null,
          instanceId: 'pinst_local',
          lastIssue: null,
          platform: 'darwin',
          proxiedCount: 99,
        }),
      },
      [
        {
          activeNode: 'stale-node',
          aliveNodeCount: 0,
          appliedRevision: 1,
          arch: 'arm64',
          artifacts: [],
          engineState: 'stopped',
          engineVersion: null,
          fallbackCount: 4,
          healing: null,
          instanceId: 'pinst_local',
          isCurrent: true,
          lastHeartbeatAt: heartbeatAt,
          lastIssue: {
            at: heartbeatAt,
            code: 'exited',
            detail: 'stale',
          },
          platform: 'darwin',
          proxiedCount: 7,
          updatedAt: heartbeatAt,
        },
      ],
      'pinst_local',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.artifacts).toEqual([
      { installed: true, kind: 'geoip', source: 'download', version: 'abc' },
    ]);
    expect(rows[0]?.engineState).toBe('running');
    expect(rows[0]?.engineVersion).toBe('v1.19.30');
    expect(rows[0]?.activeNode).toBe('node-live');
    expect(rows[0]?.aliveNodeCount).toBe(3);
    expect(rows[0]?.appliedRevision).toBe(9);
    expect(rows[0]?.lastIssue).toBeNull();
    expect(rows[0]?.lastHeartbeatAt).toBe(heartbeatAt);
    expect(rows[0]?.updatedAt).toBe(heartbeatAt);
    expect(rows[0]?.fallbackCount).toBe(4);
    expect(rows[0]?.proxiedCount).toBe(7);
  });
});

describe('runLocalArtifactInstall', () => {
  it('reports local instance status after a successful install', async () => {
    const reportLocalInstanceStatus = vi.fn(async () => true);
    const result = await runLocalArtifactInstall(
      {
        artifactManager: {
          installFromDownload: vi.fn(async () => ({ sha256: 'abc', version: 'v1' })),
        },
        reportLocalInstanceStatus,
      } as never,
      'geoip',
      null,
    );
    expect(result).toEqual({ error: null, ok: true, sha256: 'abc', version: 'v1' });
    expect(reportLocalInstanceStatus).toHaveBeenCalledTimes(1);
  });

  it('does not report status when install fails', async () => {
    const reportLocalInstanceStatus = vi.fn(async () => true);
    const result = await runLocalArtifactInstall(
      {
        artifactManager: {
          installFromDownload: vi.fn(async () => {
            throw new Error('boom');
          }),
        },
        redactSecrets: (text: string) => text,
        reportLocalInstanceStatus,
      } as never,
      'geoip',
      null,
    );
    expect(result.ok).toBe(false);
    expect(reportLocalInstanceStatus).not.toHaveBeenCalled();
  });
});

describe('handleNetworkProxyArtifactUpload', () => {
  const ctx = { serverDB: {} as LobeChatDatabase, userId: 'admin-1' };

  afterEach(() => {
    appendSpy.mockReset();
    setNetworkProxyRuntimeForTests(null);
  });

  it('returns 411 and audits when Content-Length is missing', async () => {
    const res = await handleNetworkProxyArtifactUpload(
      new Request('https://example.com/webapi/admin/network-proxy/artifact?kind=engine', {
        method: 'POST',
      }),
      ctx,
    );
    expect(res.status).toBe(411);
    expect(await res.json()).toEqual({ code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT });
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        afterDiff: expect.objectContaining({ error: 'length_required', source: 'upload' }),
        result: 'failure',
      }),
    );
  });

  it('returns 413 and audits when Content-Length is over the cap', async () => {
    const res = await handleNetworkProxyArtifactUpload(
      new Request('https://example.com/webapi/admin/network-proxy/artifact?kind=engine', {
        headers: { 'content-length': String(80 * 1024 * 1024) },
        method: 'POST',
      }),
      ctx,
    );
    expect(res.status).toBe(413);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        afterDiff: expect.objectContaining({ error: 'payload_too_large' }),
        result: 'failure',
      }),
    );
  });

  it('returns 400 and audits an invalid kind without reading a file', async () => {
    const res = await handleNetworkProxyArtifactUpload(
      new Request('https://example.com/webapi/admin/network-proxy/artifact?kind=nope', {
        headers: { 'content-length': '128' },
        method: 'POST',
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        afterDiff: expect.objectContaining({ error: 'invalid_kind', kind: 'invalid' }),
        result: 'failure',
      }),
    );
  });

  it('returns 400 and audits a missing file field', async () => {
    const form = new FormData();
    form.set('note', 'no-file');
    const res = await handleNetworkProxyArtifactUpload(
      new Request('https://example.com/webapi/admin/network-proxy/artifact?kind=engine', {
        body: form,
        headers: { 'content-length': '256' },
        method: 'POST',
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        afterDiff: expect.objectContaining({ error: 'missing_file' }),
        result: 'failure',
      }),
    );
  });

  it('installs from the uploaded stream and audits sha256/version', async () => {
    const installFromStream = vi.fn(async () => ({
      pinnedDigestMatch: true,
      sha256: 'abc123',
      version: 'v1.19.30',
    }));
    setNetworkProxyRuntimeForTests({
      artifactManager: {
        getStatus: vi.fn(async () => []),
        installFromDownload: vi.fn(),
        installFromStream,
      },
      redactSecrets: (text: string) => text,
    });
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'mihomo.bin'));
    const res = await handleNetworkProxyArtifactUpload(
      new Request('https://example.com/webapi/admin/network-proxy/artifact?kind=engine', {
        body: form,
        headers: { 'content-length': '128' },
        method: 'POST',
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      pinnedDigestMatch: true,
      sha256: 'abc123',
      version: 'v1.19.30',
    });
    expect(installFromStream).toHaveBeenCalledOnce();
    expect(installFromStream).toHaveBeenCalledWith(
      'engine',
      expect.anything(),
      expect.objectContaining({ acceptMismatch: false, source: 'upload' }),
    );
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        afterDiff: expect.objectContaining({
          sha256: 'abc123',
          source: 'upload',
          version: 'v1.19.30',
        }),
        result: 'success',
      }),
    );
  });

  it('maps a rejected checksum mismatch to the platform code with a 400, not the tRPC code', async () => {
    const { throwNetworkProxyError } = await import('../../services/networkProxy/engine/errors');
    setNetworkProxyRuntimeForTests({
      artifactManager: {
        getStatus: vi.fn(async () => []),
        installFromDownload: vi.fn(),
        installFromStream: vi.fn(async () =>
          throwNetworkProxyError(PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH),
        ),
      },
      redactSecrets: (text: string) => text,
    });
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1])], 'geosite.dat'));
    const res = await handleNetworkProxyArtifactUpload(
      new Request('https://example.com/webapi/admin/network-proxy/artifact?kind=geosite', {
        body: form,
        headers: { 'content-length': '128' },
        method: 'POST',
      }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH,
    });
  });

  it("forwards the operator's acceptance of a checksum mismatch and audits it as unverified", async () => {
    const installFromStream = vi.fn(async () => ({
      pinnedDigestMatch: false,
      sha256: 'deadbeef',
      version: 'v1.19.30',
    }));
    setNetworkProxyRuntimeForTests({
      artifactManager: {
        getStatus: vi.fn(async () => []),
        installFromDownload: vi.fn(),
        installFromStream,
      },
      redactSecrets: (text: string) => text,
    });
    const form = new FormData();
    form.set('file', new File([new Uint8Array([9, 9, 9])], 'mihomo.bin'));
    const res = await handleNetworkProxyArtifactUpload(
      new Request(
        'https://example.com/webapi/admin/network-proxy/artifact?kind=engine&acceptMismatch=1',
        { body: form, headers: { 'content-length': '128' }, method: 'POST' },
      ),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pinnedDigestMatch: false });
    expect(installFromStream).toHaveBeenCalledWith(
      'engine',
      expect.anything(),
      expect.objectContaining({ acceptMismatch: true, source: 'upload' }),
    );
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        afterDiff: expect.objectContaining({ pinnedDigestMatch: false, sha256: 'deadbeef' }),
        result: 'success',
      }),
    );
  });
});

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected throw');
};

describe('mapNetworkProxyError', () => {
  it('rethrows TRPCError as-is', () => {
    const error = new TRPCError({ code: 'BAD_REQUEST', message: 'already mapped' });
    expect(thrown(() => mapNetworkProxyError(error))).toBe(error);
  });

  it('maps PlatformRevisionConflictError to PLATFORM_REVISION_CONFLICT', () => {
    const details = { currentRevision: 4, expectedRevision: 3 };
    const error = thrown(() =>
      mapNetworkProxyError(new PlatformRevisionConflictError('conflict', details)),
    );
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('CONFLICT');
    expect(getEnterpriseErrorBody(error)).toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
      details,
    });
  });

  it('maps ZodError to PLATFORM_INVALID_INPUT with issueCount', () => {
    let zodError: z.ZodError;
    try {
      z.object({ a: z.string(), b: z.string() }).parse({});
      throw new Error('expected ZodError');
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      zodError = error;
    }

    const mapped = thrown(() => mapNetworkProxyError(zodError));
    expect(getEnterpriseErrorBody(mapped)).toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
      details: { issueCount: 2 },
    });
  });

  it('rethrows when getEnterpriseErrorBody returns a code', () => {
    const error = Object.assign(new Error('wrapped'), {
      cause: { data: { code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND } },
    });
    expect(thrown(() => mapNetworkProxyError(error))).toBe(error);
  });

  it('maps { code } in PLATFORM_ERROR_CODES via throwEnterpriseError', () => {
    const mapped = thrown(() =>
      mapNetworkProxyError({
        code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
        details: { resourceId: 'np_1' },
      }),
    );
    expect(mapped).toBeInstanceOf(TRPCError);
    expect(getEnterpriseErrorBody(mapped)).toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND,
      details: { resourceId: 'np_1' },
    });
  });

  it('maps Error whose message is a platform code to that code', () => {
    const mapped = thrown(() =>
      mapNetworkProxyError(new Error(PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED)),
    );
    expect(getEnterpriseErrorBody(mapped)?.code).toBe(
      PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
    );
  });

  it('maps unknown errors to PLATFORM_CONFIG_VALIDATION_FAILED and logs once', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mapped = thrown(() => mapNetworkProxyError(new Error('boom')));
    expect((mapped as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    expect(getEnterpriseErrorBody(mapped)).toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
      details: { reason: 'operation_failed' },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('[admin.networkProxy] unexpected operation failure', {
      errorClass: 'Error',
    });
    spy.mockRestore();
  });
});

const connectivityRuntime = (overrides: Record<string, unknown> = {}) =>
  ({
    getDispatcherFor: vi.fn(() => ({ id: 'dispatcher' })),
    getEngineRuntime: () => ({
      getState: () => ({ proxyUrl: 'http://127.0.0.1:7890', state: 'running' }),
    }),
    getOutletHealth: () => ({ kind: 'engine' }),
    peekNetworkProxySnapshot: () => ({ staticProxyUrl: 'http://static.example:8080' }),
    redactSecrets: (text: string) => `redacted:${text}`,
    ...overrides,
  }) as never;

const mockOkResponse = (status = 200, text = '') => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => text,
});

describe('testOutletConnectivity', () => {
  afterEach(() => {
    fetchMock.mockReset();
    ProxyAgentMock.mockReset();
  });

  it('returns outlet_unavailable when the selected proxyUrl is null', async () => {
    await expect(
      testOutletConnectivity(
        connectivityRuntime({
          getEngineRuntime: () => ({ getState: () => ({ proxyUrl: null, state: 'stopped' }) }),
          getOutletHealth: () => ({ kind: 'engine' }),
        }),
        'https://latency.example/ping',
      ),
    ).resolves.toEqual({
      egressIp: null,
      error: 'outlet_unavailable',
      latencyMs: null,
      ok: false,
    });

    await expect(
      testOutletConnectivity(
        connectivityRuntime({
          getOutletHealth: () => ({ kind: 'static' }),
          peekNetworkProxySnapshot: () => ({ staticProxyUrl: null }),
        }),
        'https://latency.example/ping',
      ),
    ).resolves.toEqual({
      egressIp: null,
      error: 'outlet_unavailable',
      latencyMs: null,
      ok: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok with egressIp when latency GET and api.ip.sb succeed', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://api.ip.sb/ip') return mockOkResponse(200, '  203.0.113.10  ');
      return mockOkResponse(200);
    });

    const result = await testOutletConnectivity(
      connectivityRuntime(),
      'https://latency.example/ping',
    );
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.egressIp).toBe('203.0.113.10');
    expect(result.latencyMs).toEqual(expect.any(Number));
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://latency.example/ping',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.ip.sb/ip',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('swallows ip.sb throw / non-ok and still returns ok with null egressIp', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://api.ip.sb/ip') throw new Error('ip lookup failed');
      return mockOkResponse(200);
    });
    await expect(
      testOutletConnectivity(connectivityRuntime(), 'https://latency.example/ping'),
    ).resolves.toMatchObject({ egressIp: null, error: null, ok: true });

    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://api.ip.sb/ip') return mockOkResponse(502);
      return mockOkResponse(200);
    });
    await expect(
      testOutletConnectivity(connectivityRuntime(), 'https://latency.example/ping'),
    ).resolves.toMatchObject({ egressIp: null, error: null, ok: true });
  });

  it('maps a non-ok latency GET to a redacted http_STATUS error', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://api.ip.sb/ip') return mockOkResponse(200, '203.0.113.10');
      return mockOkResponse(503);
    });

    const result = await testOutletConnectivity(
      connectivityRuntime(),
      'https://latency.example/ping',
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('redacted:http_503');
    expect(result.latencyMs).toEqual(expect.any(Number));
  });

  it('maps a thrown latency GET to a redacted message and sets latencyMs', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const result = await testOutletConnectivity(
      connectivityRuntime(),
      'https://latency.example/ping',
    );
    expect(result).toMatchObject({
      egressIp: null,
      error: 'redacted:connect ECONNREFUSED',
      ok: false,
    });
    expect(result.latencyMs).toEqual(expect.any(Number));
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('uses createInlineDispatcher (ProxyAgent) when getDispatcherFor is missing', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'https://api.ip.sb/ip') return mockOkResponse(200, '203.0.113.10');
      return mockOkResponse(200);
    });

    await testOutletConnectivity(
      connectivityRuntime({ getDispatcherFor: null }),
      'https://latency.example/ping',
    );
    expect(ProxyAgentMock).toHaveBeenCalledWith({ uri: 'http://127.0.0.1:7890' });
  });

  it('reads static proxyUrl from the snapshot and engine proxyUrl from engine state', async () => {
    fetchMock.mockResolvedValue(mockOkResponse(200, '203.0.113.10'));
    const staticDispatcher = vi.fn((proxyUrl: string) => ({ id: 'static', proxyUrl }));
    await testOutletConnectivity(
      connectivityRuntime({
        getDispatcherFor: staticDispatcher,
        getEngineRuntime: () => ({
          getState: () => ({ proxyUrl: 'http://engine-unused:7890', state: 'running' }),
        }),
        getOutletHealth: () => ({ kind: 'static' }),
        peekNetworkProxySnapshot: () => ({ staticProxyUrl: 'http://static.example:8080' }),
      }),
      'https://latency.example/ping',
    );
    expect(staticDispatcher).toHaveBeenCalledWith('http://static.example:8080');

    const engineDispatcher = vi.fn((proxyUrl: string) => ({ id: 'engine', proxyUrl }));
    await testOutletConnectivity(
      connectivityRuntime({
        getDispatcherFor: engineDispatcher,
        getEngineRuntime: () => ({
          getState: () => ({ proxyUrl: 'http://engine.example:7890', state: 'running' }),
        }),
        getOutletHealth: () => ({ kind: 'engine' }),
        peekNetworkProxySnapshot: () => ({ staticProxyUrl: 'http://static-unused:8080' }),
      }),
      'https://latency.example/ping',
    );
    expect(engineDispatcher).toHaveBeenCalledWith('http://engine.example:7890');
  });
});
