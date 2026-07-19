// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { PlatformSecretService } from '../platformSecretService';
import { VaultKeyProvider } from './vaultKeyProvider';

const TOKEN = 'test-token-value-do-not-use';
const ROLE_ID = 'test-role-id-do-not-use';
const SECRET_ID = 'test-secret-id-do-not-use';
const ACTIVE_KEY = Buffer.alloc(32, 0x11).toString('base64');
const HISTORICAL_KEY = Buffer.alloc(32, 0x22).toString('base64');

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });

const lookupResponse = (overrides: Record<string, unknown> = {}) =>
  jsonResponse({
    data: {
      policies: ['aihub-kek-read'],
      renewable: true,
      ttl: 60,
      ...overrides,
    },
  });

const keyResponse = (
  activeKeyId = 'vault:key-2',
  historical: Array<{ key: string; keyId: string }> = [
    { key: HISTORICAL_KEY, keyId: 'vault:key-1' },
  ],
) =>
  jsonResponse({
    data: {
      data: {
        active: { key: ACTIVE_KEY, keyId: activeKeyId },
        historical,
      },
      metadata: { version: 2 },
    },
  });

const tokenProvider = (fetcher: typeof fetch, options: Record<string, unknown> = {}) =>
  new VaultKeyProvider({
    auth: { method: 'token', token: TOKEN },
    fetch: fetcher,
    ...options,
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('VaultKeyProvider', () => {
  it('reads active and historical KEKs from KV v2 with a validated scoped token', async () => {
    const requests: Array<{ init: RequestInit | undefined; url: string }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      requests.push({ init, url });
      if (url.endsWith('/v1/auth/token/lookup-self')) return lookupResponse();
      return keyResponse();
    });
    const provider = tokenProvider(fetcher);

    await expect(provider.getKek()).resolves.toEqual({
      key: new Uint8Array(Buffer.from(ACTIVE_KEY, 'base64')),
      keyId: 'vault:key-2',
    });
    await expect(provider.getKek('vault:key-1')).resolves.toEqual({
      key: new Uint8Array(Buffer.from(HISTORICAL_KEY, 'base64')),
      keyId: 'vault:key-1',
    });
    expect(requests.map(({ url }) => url)).toEqual([
      'http://127.0.0.1:8200/v1/auth/token/lookup-self',
      'http://127.0.0.1:8200/v1/aihub/data/platform/master-key',
    ]);
    expect(
      requests.every(({ init }) => init?.headers && !JSON.stringify(init.headers).includes('root')),
    ).toBe(true);
    expect(requests.every(({ url }) => !url.includes(TOKEN))).toBe(true);
  });

  it('uses AppRole login, validates the resulting token, and never puts credentials in URLs', async () => {
    const urls: string[] = [];
    const bodies: Array<string | undefined> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      urls.push(url);
      bodies.push(init?.body?.toString());
      if (url.endsWith('/v1/auth/custom-approle/login')) {
        return jsonResponse({ auth: { client_token: TOKEN } });
      }
      if (url.endsWith('/v1/auth/token/lookup-self')) return lookupResponse();
      return keyResponse();
    });
    const provider = new VaultKeyProvider({
      auth: {
        authMountPath: 'custom-approle',
        method: 'approle',
        roleId: ROLE_ID,
        secretId: SECRET_ID,
      },
      fetch: fetcher,
    });

    await expect(provider.getKek()).resolves.toMatchObject({ keyId: 'vault:key-2' });
    expect(urls).toHaveLength(3);
    expect(urls.every((url) => !url.includes(ROLE_ID) && !url.includes(SECRET_ID))).toBe(true);
    expect(JSON.parse(bodies[0]!)).toEqual({ role_id: ROLE_ID, secret_id: SECRET_ID });
  });

  it('prefers complete AppRole config over a token and rejects partial AppRole config', () => {
    const provider = VaultKeyProvider.fromEnv({
      VAULT_APPROLE_ROLE_ID: ROLE_ID,
      VAULT_APPROLE_SECRET_ID: SECRET_ID,
      VAULT_TOKEN: TOKEN,
    });
    expect(provider.providerId).toBe('vault');
    expect(() =>
      VaultKeyProvider.fromEnv({ VAULT_APPROLE_ROLE_ID: ROLE_ID, VAULT_TOKEN: TOKEN }),
    ).toThrow(/both role ID and secret ID/i);
  });

  it('rejects root policy for token and AppRole authentication', async () => {
    const tokenFetch = vi.fn<typeof fetch>(async () => lookupResponse({ policies: ['root'] }));
    await expect(tokenProvider(tokenFetch).getKek()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE,
      details: { reason: 'root-token-rejected' },
    });

    const appRoleFetch = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/login')
        ? jsonResponse({ auth: { client_token: TOKEN } })
        : lookupResponse({ policies: ['default', 'root'] }),
    );
    const appRole = new VaultKeyProvider({
      auth: { method: 'approle', roleId: ROLE_ID, secretId: SECRET_ID },
      fetch: appRoleFetch,
    });
    await expect(appRole.getKek()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE,
    });
  });

  it.each([
    {},
    { policies: [], renewable: true, ttl: 60 },
    { policies: ['aihub-kek-read'], renewable: 'yes', ttl: 60 },
    { policies: ['aihub-kek-read'], renewable: true, ttl: '60' },
    { policies: ['aihub-kek-read'], renewable: true, ttl: -1 },
  ])('rejects malformed lookup-self metadata %#', async (data) => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ data }));
    await expect(tokenProvider(fetcher).getKek()).rejects.toMatchObject({
      details: { reason: 'invalid-token-metadata' },
      message: 'Vault key material is unavailable',
    });
  });

  it('single-flights concurrent authentication and KV reads', async () => {
    let lookupCalls = 0;
    let readCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      await Promise.resolve();
      if (String(input).endsWith('/lookup-self')) {
        lookupCalls += 1;
        return lookupResponse();
      }
      readCalls += 1;
      return keyResponse();
    });
    const provider = tokenProvider(fetcher);

    const results = await Promise.all(Array.from({ length: 30 }, () => provider.getKek()));
    expect(results.every(({ keyId }) => keyId === 'vault:key-2')).toBe(true);
    expect(lookupCalls).toBe(1);
    expect(readCalls).toBe(1);
  });

  it('renews a renewable token before expiry and revalidates it', async () => {
    let now = 0;
    let lookupCalls = 0;
    let renewCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/lookup-self')) {
        lookupCalls += 1;
        return lookupResponse({ ttl: 60 });
      }
      if (url.endsWith('/renew-self')) {
        renewCalls += 1;
        return jsonResponse({ auth: { renewable: true } });
      }
      return keyResponse();
    });
    const provider = tokenProvider(fetcher, {
      clock: () => now,
      keyCacheTtlMs: 100,
      renewBeforeMs: 30_000,
      tokenCacheTtlMs: 60_000,
    });

    await provider.getKek();
    now = 31_000;
    await provider.getKek();
    expect(renewCalls).toBe(1);
    expect(lookupCalls).toBe(2);
  });

  it('relogs with AppRole after renewal failure and never retains an expired token', async () => {
    let now = 0;
    let loginCalls = 0;
    let renewCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/login')) {
        loginCalls += 1;
        return jsonResponse({ auth: { client_token: `${TOKEN}-${loginCalls}` } });
      }
      if (url.endsWith('/lookup-self')) return lookupResponse({ ttl: 1 });
      if (url.endsWith('/renew-self')) {
        renewCalls += 1;
        return jsonResponse({ errors: ['denied'] }, 403);
      }
      return keyResponse();
    });
    const provider = new VaultKeyProvider({
      auth: { method: 'approle', roleId: ROLE_ID, secretId: SECRET_ID },
      clock: () => now,
      fetch: fetcher,
      keyCacheTtlMs: 100,
      renewBeforeMs: 500,
      tokenCacheTtlMs: 1000,
    });

    await provider.getKek();
    now = 600;
    await provider.getKek();
    expect(renewCalls).toBe(1);
    expect(loginCalls).toBe(2);
  });

  it('fails closed when renewal of an explicit token fails', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/lookup-self')) return lookupResponse({ ttl: 1 });
      if (url.endsWith('/renew-self')) return jsonResponse({ errors: ['denied'] }, 403);
      return keyResponse();
    });
    const provider = tokenProvider(fetcher, {
      clock: () => now,
      keyCacheTtlMs: 100,
      renewBeforeMs: 500,
      tokenCacheTtlMs: 1000,
    });
    await provider.getKek();
    now = 600;
    await expect(provider.getKek()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE,
    });
  });

  it('does not serve a cached KEK beyond the validated token expiry', async () => {
    let now = 0;
    let lookupCalls = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/lookup-self')) {
        lookupCalls += 1;
        return lookupCalls === 1
          ? lookupResponse({ renewable: false, ttl: 1 })
          : jsonResponse({ errors: ['expired'] }, 403);
      }
      return keyResponse();
    });
    const provider = tokenProvider(fetcher, {
      clock: () => now,
      keyCacheTtlMs: 5000,
      renewBeforeMs: 0,
      tokenCacheTtlMs: 5000,
    });
    await provider.getKek();
    now = 1000;
    await expect(provider.getKek()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE,
    });
    expect(lookupCalls).toBe(2);
  });

  it.each([403, 404, 429, 500, 503])(
    'fails closed with sanitized errors for Vault HTTP %s',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(async (input) =>
        String(input).endsWith('/lookup-self')
          ? lookupResponse()
          : jsonResponse({ errors: [`sensitive-${TOKEN}`] }, status),
      );
      const error = await tokenProvider(fetcher)
        .getKek()
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE,
        message: 'Vault key material is unavailable',
      });
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    },
  );

  it('fails closed for network errors, malformed JSON, oversized payloads, and timeout aborts', async () => {
    const network = tokenProvider(
      vi.fn<typeof fetch>(async () => {
        throw new Error(TOKEN);
      }),
    );
    await expect(network.getKek()).rejects.toMatchObject({
      details: { reason: 'network-error' },
      message: 'Vault key material is unavailable',
    });

    const malformed = tokenProvider(vi.fn<typeof fetch>(async () => new Response('{')));
    await expect(malformed.getKek()).rejects.toMatchObject({ details: { reason: 'invalid-json' } });

    const oversized = tokenProvider(
      vi.fn<typeof fetch>(
        async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024) } }),
      ),
    );
    await expect(oversized.getKek()).rejects.toMatchObject({
      details: { reason: 'response-too-large' },
    });

    vi.useFakeTimers();
    const hangingFetch = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const timed = tokenProvider(hangingFetch, { requestTimeoutMs: 100 });
    const pending = expect(timed.getKek()).rejects.toMatchObject({
      details: { reason: 'request-timeout' },
    });
    await vi.advanceTimersByTimeAsync(100);
    await pending;
  });

  it.each([
    undefined,
    null,
    {},
    { active: { key: ACTIVE_KEY, keyId: 'vault:key-2' } },
    { active: { extra: true, key: ACTIVE_KEY, keyId: 'vault:key-2' }, historical: [] },
    { active: { key: 'not-base64', keyId: 'vault:key-2' }, historical: [] },
    { active: { key: Buffer.alloc(16).toString('base64'), keyId: 'vault:key-2' }, historical: [] },
    { active: { key: ACTIVE_KEY, keyId: '../escape' }, historical: [] },
    {
      active: { key: ACTIVE_KEY, keyId: 'vault:key-2' },
      historical: [{ key: HISTORICAL_KEY, keyId: 'vault:key-2' }],
    },
    {
      active: { key: ACTIVE_KEY, keyId: 'vault:key-2' },
      historical: Array.from({ length: 257 }, (_, index) => ({
        key: HISTORICAL_KEY,
        keyId: `vault:old-${index}`,
      })),
    },
  ])('rejects malformed or ambiguous KV schema %#', async (secret) => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/lookup-self')
        ? lookupResponse()
        : jsonResponse({ data: { data: secret } }),
    );
    await expect(tokenProvider(fetcher).getKek()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PLATFORM_SECRET_NOT_READABLE,
      message: 'Vault key material is unavailable',
    });
  });

  it('rejects unknown key IDs and unsafe configuration', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/lookup-self') ? lookupResponse() : keyResponse(),
    );
    const provider = tokenProvider(fetcher);
    await expect(provider.getKek('vault:missing')).rejects.toMatchObject({
      details: { reason: 'unknown-key-id' },
    });
    expect(
      () =>
        new VaultKeyProvider({
          auth: { method: 'token', token: TOKEN },
          mountPath: '../sys',
        }),
    ).toThrow(/mount/i);
    expect(
      () =>
        new VaultKeyProvider({
          auth: { method: 'token', token: TOKEN },
          secretPath: 'platform/../master-key',
        }),
    ).toThrow(/secret path/i);
    expect(
      () =>
        new VaultKeyProvider({
          address: `http://${TOKEN}@127.0.0.1:8200`,
          auth: { method: 'token', token: TOKEN },
        }),
    ).toThrow(/without credentials/i);
    expect(
      () =>
        new VaultKeyProvider({
          auth: { method: 'token', token: `${TOKEN}\nheader-injection` },
        }),
    ).toThrow(/token is missing or invalid/i);
  });

  it('integrates with PlatformSecretService for historical decrypt and active-key encryption', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/lookup-self') ? lookupResponse() : keyResponse(),
    );
    const service = new PlatformSecretService({ keyProvider: tokenProvider(fetcher) });
    const ciphertext = await service.encrypt('vault-backed-secret');
    expect(service.peekKeyId(ciphertext)).toBe('vault:key-2');
    await expect(service.decrypt(ciphertext)).resolves.toBe('vault-backed-secret');
  });

  it('does not expose credentials or cached secrets through JSON serialization', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/lookup-self') ? lookupResponse() : keyResponse(),
    );
    const provider = tokenProvider(fetcher);
    await provider.getKek();
    const serialized = JSON.stringify(provider);
    expect(serialized).toBe('{"providerId":"vault"}');
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(ACTIVE_KEY);
    expect(JSON.stringify({ ...provider })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...provider })).not.toContain(ACTIVE_KEY);
  });
});
