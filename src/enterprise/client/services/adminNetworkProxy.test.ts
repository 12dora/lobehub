// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminNetworkProxyService,
  buildAdminUploadHeaders,
  NETWORK_PROXY_ARTIFACT_UPLOAD_PATH,
} from './adminNetworkProxy';

const installGeodataMutate = vi.hoisted(() => vi.fn());

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      networkProxy: {
        installGeodata: { mutate: installGeodataMutate },
      },
    },
  },
}));

vi.mock('@/services/_auth', () => ({
  createHeaderWithAuth: vi.fn(async () => ({
    'Content-Type': 'application/json',
    'Oidc-Auth': 'jwt-token',
  })),
}));

vi.mock('@/business/client/trpc-headers', () => ({
  getBusinessTrpcHeaders: vi.fn(async () => ({ 'X-Workspace-Id': 'ws_1' })),
}));

interface FakeXhrRecord {
  aborted: boolean;
  body: FormData | null;
  headers: Record<string, string>;
  url: string;
  withCredentials: boolean;
}

class FakeXhr {
  static last: FakeXhr | null = null;
  readonly record: FakeXhrRecord = {
    aborted: false,
    body: null,
    headers: {},
    url: '',
    withCredentials: false,
  };
  responseText = '';
  responseType = '';
  status = 200;
  upload = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (type === 'progress') this.#progress = fn;
    },
  };
  #listeners: Record<string, (() => void)[]> = {};
  #progress: ((event: unknown) => void) | null = null;

  constructor() {
    FakeXhr.last = this;
  }

  get withCredentials() {
    return this.record.withCredentials;
  }
  set withCredentials(value: boolean) {
    this.record.withCredentials = value;
  }

  open(_method: string, url: string) {
    this.record.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.record.headers[name] = value;
  }

  addEventListener(type: string, fn: () => void) {
    (this.#listeners[type] ??= []).push(fn);
  }

  send(body: FormData) {
    this.record.body = body;
  }

  abort() {
    this.record.aborted = true;
    this.#emit('abort');
  }

  emitProgress(loaded: number, total: number) {
    this.#progress?.({ lengthComputable: true, loaded, total });
  }

  finish(status: number, responseText: string) {
    this.status = status;
    this.responseText = responseText;
    this.#emit('load');
  }

  fail() {
    this.#emit('error');
  }

  #emit(type: string) {
    for (const fn of this.#listeners[type] ?? []) fn();
  }
}

const file = (size = 1024) => {
  const blob = new Blob([new Uint8Array(size)], { type: 'application/gzip' });
  return new File([blob], 'mihomo.gz', { type: 'application/gzip' });
};

beforeEach(() => {
  FakeXhr.last = null;
  installGeodataMutate.mockReset();
  vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
});

describe('buildAdminUploadHeaders', () => {
  it('carries the same auth + business headers the tRPC client sends', async () => {
    const headers = await buildAdminUploadHeaders();
    expect(headers['Oidc-Auth']).toBe('jwt-token');
    expect(headers['X-Workspace-Id']).toBe('ws_1');
  });

  it('never sets Content-Type — the browser owns the multipart boundary', async () => {
    const headers = await buildAdminUploadHeaders();
    expect('Content-Type' in headers).toBe(false);
    expect('content-type' in headers).toBe(false);
  });
});

describe('adminNetworkProxyService.uploadArtifact', () => {
  it('posts to the guarded route with credentials, headers and the file', async () => {
    const promise = adminNetworkProxyService.uploadArtifact({ file: file(), kind: 'engine' });
    await vi.waitFor(() => expect(FakeXhr.last).not.toBeNull());
    const xhr = FakeXhr.last!;

    expect(xhr.record.url).toBe(`${NETWORK_PROXY_ARTIFACT_UPLOAD_PATH}?kind=engine`);
    // Cookie-authenticated admins rely on this; header-authenticated ones on the headers.
    expect(xhr.record.withCredentials).toBe(true);
    expect(xhr.record.headers['Oidc-Auth']).toBe('jwt-token');
    expect(xhr.record.headers['X-Workspace-Id']).toBe('ws_1');
    expect(xhr.record.headers['Content-Type']).toBeUndefined();
    expect(xhr.record.body).toBeInstanceOf(FormData);

    xhr.finish(200, JSON.stringify({ ok: true, sha256: 'abc', version: 'v1.19.30' }));
    await expect(promise).resolves.toEqual({ ok: true, sha256: 'abc', version: 'v1.19.30' });
  });

  it('reports transfer progress so a 45 MB upload is not a frozen button', async () => {
    const onProgress = vi.fn();
    const promise = adminNetworkProxyService.uploadArtifact({
      file: file(),
      kind: 'geoip',
      onProgress,
    });
    await vi.waitFor(() => expect(FakeXhr.last).not.toBeNull());
    const xhr = FakeXhr.last!;

    xhr.emitProgress(50, 200);
    expect(onProgress).toHaveBeenCalledWith(0.25);

    xhr.finish(200, JSON.stringify({ ok: true, sha256: 'a', version: 'x' }));
    await promise;
  });

  it('surfaces the server error code so reauth retry and copy lookup both work', async () => {
    const promise = adminNetworkProxyService.uploadArtifact({ file: file(), kind: 'engine' });
    await vi.waitFor(() => expect(FakeXhr.last).not.toBeNull());
    FakeXhr.last!.finish(401, JSON.stringify({ code: 'ADMIN_REAUTH_REQUIRED' }));

    await expect(promise).rejects.toMatchObject({
      data: { code: 'ADMIN_REAUTH_REQUIRED' },
      message: 'ADMIN_REAUTH_REQUIRED',
    });
  });

  it('falls back to a status-derived code for a non-JSON failure body', async () => {
    const promise = adminNetworkProxyService.uploadArtifact({ file: file(), kind: 'engine' });
    await vi.waitFor(() => expect(FakeXhr.last).not.toBeNull());
    FakeXhr.last!.finish(502, '<html>gateway</html>');

    await expect(promise).rejects.toMatchObject({ message: 'ADMIN_UPLOAD_FAILED_502' });
  });

  it('aborts the transfer when the caller cancels', async () => {
    const controller = new AbortController();
    const promise = adminNetworkProxyService.uploadArtifact({
      file: file(),
      kind: 'engine',
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(FakeXhr.last).not.toBeNull());

    controller.abort();
    expect(FakeXhr.last!.record.aborted).toBe(true);
    await expect(promise).rejects.toMatchObject({ message: 'ADMIN_UPLOAD_ABORTED' });
  });

  it('never opens a request for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      adminNetworkProxyService.uploadArtifact({
        file: file(),
        kind: 'engine',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ message: 'ADMIN_UPLOAD_ABORTED' });
    expect(FakeXhr.last?.record.body ?? null).toBeNull();
  });
});

describe('adminNetworkProxyService.installGeodata', () => {
  it('forwards expectedRevision to admin.networkProxy.installGeodata', async () => {
    const payload = {
      config: {},
      desiredArtifacts: {},
      engineGeneration: 0,
      globalProxyActive: false,
      local: { error: null, ok: true },
      results: [
        { error: null, kind: 'geoip', ok: true },
        { error: null, kind: 'geosite', ok: true },
      ],
      revision: 2,
    };
    installGeodataMutate.mockResolvedValueOnce(payload);

    await expect(adminNetworkProxyService.installGeodata({ expectedRevision: 3 })).resolves.toEqual(
      payload,
    );
    expect(installGeodataMutate).toHaveBeenCalledWith({ expectedRevision: 3 });
  });
});
