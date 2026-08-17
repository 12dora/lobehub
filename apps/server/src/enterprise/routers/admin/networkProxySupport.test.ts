// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import type { LobeChatDatabase } from '@/database/type';
import type { NetworkProxyConfigUpdate } from '@/types/platform/networkProxy';
import { createDefaultNetworkProxyConfig } from '@/types/platform/networkProxy';

import {
  assertUploadContentLength,
  handleNetworkProxyArtifactUpload,
  hashNameForAudit,
  isDangerousSettingsUpdate,
  redactSecretsFallback,
  rejectOversizedUpload,
  setNetworkProxyRuntimeForTests,
} from './networkProxySupport';

const appendSpy = vi.hoisted(() => vi.fn());

vi.mock('../../services/platformAudit', () => ({
  PlatformAuditService: class {
    append = appendSpy;
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
    const installFromStream = vi.fn(async () => ({ sha256: 'abc123', version: 'v1.19.30' }));
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
    expect(await res.json()).toEqual({ ok: true, sha256: 'abc123', version: 'v1.19.30' });
    expect(installFromStream).toHaveBeenCalledOnce();
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
});
