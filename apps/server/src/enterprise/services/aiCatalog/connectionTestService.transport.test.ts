// @vitest-environment node
import {
  getBoundFetch,
  ModelRuntime,
  providerRuntimeMap,
  resetBoundFetchPatchForTests,
} from '@lobechat/model-runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSafeOutboundHttpClient } from '../../security/outboundHttp';
import type { PinnedTransportResponse } from '../../security/outboundHttp/types';
import { createSafeAiConnectionProbe } from './connectionTestService';

const okJson = (body: unknown): PinnedTransportResponse => ({
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  headers: { 'content-type': 'application/json' },
  status: 200,
  statusText: 'OK',
});

/**
 * Stub DNS answers must be PUBLICLY ROUTABLE: the SafeOutbound client runs in its default
 * public-only mode, which rejects RFC 5737 documentation ranges (203.0.113.0/24 et al) with
 * PLATFORM_SSRF_BLOCKED *before* the pinned transport is reached — that denial would make
 * every assertion below vacuous.
 */
describe('AI connection test SafeOutbound transport enforcement', () => {
  const globalFetchCalls: string[] = [];
  const realFetch = globalThis.fetch.bind(globalThis);

  beforeEach(() => {
    globalFetchCalls.length = 0;
    resetBoundFetchPatchForTests();
    // Adversarial trap installed first so ensureGlobalFetchPatch captures it as "original".
    // Bound SafeOutbound traffic must never fall through to this path.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const bound = getBoundFetch();
      if (bound) return bound(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      globalFetchCalls.push(url);
      throw new Error(`GLOBAL_FETCH ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    resetBoundFetchPatchForTests();
    globalThis.fetch = realFetch;
  });

  it('routes OpenAI-compatible chat through SafeOutbound and never global fetch', async () => {
    const safeCalls: string[] = [];
    const transport = vi.fn(async (req) => {
      safeCalls.push(req.url.toString());
      // Minimal OpenAI chat completion shape
      return okJson({
        choices: [{ message: { content: 'hi', role: 'assistant' } }],
        id: 'chatcmpl-test',
        object: 'chat.completion',
      });
    });
    const outbound = createSafeOutboundHttpClient({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      transport,
    });
    const probe = createSafeAiConnectionProbe(outbound);

    await probe({
      keyVaults: { apiKey: 'sk-test-not-real' },
      model: 'gpt-test',
      provider: {
        checkModel: 'gpt-test',
        config: {},
        displayName: 'OpenAI',
        enabled: true,
        fetchOnClient: false,
        id: 'p1',
        providerKey: 'openai',
        revision: 0,
        settings: {},
        sort: 0,
        source: 'builtin',
        status: 'draft',
      } as never,
      runtimeProvider: 'openai',
    });

    expect(safeCalls.length).toBeGreaterThan(0);
    expect(safeCalls.some((u) => u.includes('openai') || u.includes('api'))).toBe(true);
    expect(globalFetchCalls).toEqual([]);
    expect(JSON.stringify(safeCalls)).not.toContain('sk-test-not-real');
  });

  it('routes Google chat through bound fetch (not unbound global fetch)', async () => {
    const safeCalls: string[] = [];
    const transport = vi.fn(async (req) => {
      safeCalls.push(req.url.toString());
      // SSE-ish success for generateContentStream is complex; return error body with 200 empty
      // that still proves the request reached SafeOutbound rather than global fetch.
      return {
        body: Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n'),
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
        statusText: 'OK',
      };
    });
    const outbound = createSafeOutboundHttpClient({
      resolve: async () => [{ address: '93.184.216.35', family: 4 }],
      transport,
    });
    const probe = createSafeAiConnectionProbe(outbound);

    try {
      await probe({
        keyVaults: { apiKey: 'google-test-key-not-real' },
        model: 'gemini-test',
        provider: {
          checkModel: 'gemini-test',
          config: {},
          displayName: 'Google',
          enabled: true,
          fetchOnClient: false,
          id: 'p2',
          providerKey: 'google',
          revision: 0,
          settings: {},
          sort: 0,
          source: 'builtin',
          status: 'draft',
        } as never,
        runtimeProvider: 'google',
      });
    } catch {
      // Stream parsing may fail on simplified body; transport reachability is the assertion.
    }

    expect(globalFetchCalls).toEqual([]);
    expect(safeCalls.some((u) => u.includes('generativelanguage.googleapis.com'))).toBe(true);
    expect(JSON.stringify(safeCalls)).not.toContain('google-test-key-not-real');
  });

  it('routes AzureAI chat through SafeOutbound httpClient without global/default Node HTTP', async () => {
    const safeCalls: string[] = [];
    const transport = vi.fn(async (req) => {
      safeCalls.push(req.url.toString());
      return okJson({
        choices: [{ finish_reason: 'stop', message: { content: 'hi', role: 'assistant' } }],
      });
    });
    const outbound = createSafeOutboundHttpClient({
      resolve: async () => [{ address: '93.184.216.37', family: 4 }],
      transport,
    });
    const probe = createSafeAiConnectionProbe(outbound);

    try {
      await probe({
        keyVaults: {
          apiKey: 'azure-key-not-real',
          baseURL: 'https://example.openai.azure.com',
          endpoint: 'https://example.openai.azure.com',
        },
        model: 'gpt-4o',
        provider: {
          checkModel: 'gpt-4o',
          config: {},
          displayName: 'Azure AI',
          enabled: true,
          fetchOnClient: false,
          id: 'p-azure',
          providerKey: 'azureai',
          revision: 0,
          settings: {},
          sort: 0,
          source: 'builtin',
          status: 'draft',
        } as never,
        runtimeProvider: 'azureai',
      });
    } catch {
      // Non-stream parsing may still throw; transport reachability is required.
    }

    expect(globalFetchCalls).toEqual([]);
    expect(safeCalls.some((u) => u.includes('example.openai.azure.com'))).toBe(true);
    expect(JSON.stringify(safeCalls)).not.toContain('azure-key-not-real');
  });

  it('routes Vertex auth token exchange through SafeOutbound when credentials require network', async () => {
    const safeCalls: string[] = [];
    const transport = vi.fn(async (req) => {
      safeCalls.push(req.url.toString());
      // Deny with a stable body — proves the auth hop hit SafeOutbound rather than Node http.
      return {
        body: Buffer.from(
          JSON.stringify({ error: 'invalid_grant', error_description: 'test-deny' }),
        ),
        headers: { 'content-type': 'application/json' },
        status: 400,
        statusText: 'Bad Request',
      };
    });
    const outbound = createSafeOutboundHttpClient({
      resolve: async () => [{ address: '93.184.216.38', family: 4 }],
      transport,
    });
    const probe = createSafeAiConnectionProbe(outbound);

    // Synthetically generated RSA key for JWT construction only — never a production secret.
    // Must be valid enough for google-auth to sign, so the OAuth token hop actually runs.
    const fakeSa = JSON.stringify({
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      client_email: 'vertex-test@example.iam.gserviceaccount.com',
      client_id: '123456789012345678901',
      private_key: `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCmDIwrvuzHbY6V
VzMSeFiZpgkMQmy93/M23OftTgzWL0I2KHfPweLd14iZTgnmFOKPzSC5AiYvifU1
73v6QT+9Gq9POnwA5+l0viIotFq3OUceIkIZY+6jOiOvDiFfVl7Q98SKVIvCSsEX
MkWp02uqi/KJcnbZ3369dswo9MQvSpkqVxy7IhdEMAQq0spF7dtJN0w10CRagOSh
G2HUiCUoI5jqQ+nM/0fiXhjn8RkNp/qIW2l0ueF/4Y3nGZK8pESMn8mfL9nbekr2
lYucWq08iWyYNaZpSXb7fSNSWMt9J5hSVKtcVI18ReVIdUAqDIPHROqypISR+J1c
sei1gOUlAgMBAAECggEAO3Yd0eKGbunkF8WIo/IVpDvpXIsC3sGuGjTkFr4O6bo1
pyg5s1u2boOqxl9EOzC6aw1lTOsgmoB4H27ZgiXQedru8Vu7oSVrG+OkXtgq7hbk
ST2yVt5KzAfbVGomeDn5LTK0nmalP5e+apyVhrmPghyoZyDmv6GBhL5gYMA56sbj
xDJQBd5jcdkjb5AwdT1B0Ky997YttNYmFxwNVwmmMQTWP847SLLqiWL9BrE2bZPH
TdH5xxsnA/JLhPp0p/Xc6y1EukdloUNoHs4XbemK+4TblnWHCASvhmCT14N1ohlP
HvWc+wJBlUWYA6AxSOYqOxqBN9hhZ+DLA8T4scpg5wKBgQDP4b0iv/i/Eaey/JgZ
zcEAnay1NsBKWvdHVXkVRrfPG1q0z2m0E8E4KBsS6CNfBcvc+7Sr9c2W/2mtt6Ll
03nxhiZxKeQAGZJ7nDZJdDjFMxXgwt27fv0ephrP1C9Y971+PqFnkNxPQFffPIOP
cFl8q6COHQNFiFXDgI6lRcfvBwKBgQDMe/ZI+gGWBdAxoFVhrhTVab4D4gRjTM7B
0aEVVHxVsY8O3nyEnNzKRB1JjrRTVl6fdcNGbQ/AnBWkVv7MQaywo60RaCfs4h9i
HZgzy8iaDwb25lTty2SPlURepqUA3LPrxL/TiWrwgzlegS8ARdDymPmiIEtYuUXh
mqUTyrUTcwKBgEwGosUysCYwrsQm3PmS5iLzh1Y+z9RhsE3GVKITWuXDe0jlEiNp
liCTilM/0q/NzuDirRC2tJmkj2GY51pmHRLXnPeF+nyO3aOXXcM/XgPAyx+IJM+N
gcTTurqHP0mqUQL6pMzbjbbuMTTTTMoIrLGLkwxmT+v+EF+PhJutCZHBAoGAUgGo
7O1us2bTbwOZGlqBOnF05gO/tL858BsNGgvO7WMPN2xczaZHGcslX7mecgmiWxsU
XGsitSEjwMuu1eXExvZtUxzNXj/1TBkIUEV6xuYd6ejHyLIYO0kmqTr105mvgm9e
awyiWaCW4mK2ocpeGNzmyHFhJkzvTKIDcCOMaScCgYApKo+O9wTEkDVDo54of50H
HVUHcPQrpBQpm5yZqDQ1mXUmzYKg5HbFuz/x83GXA1PwXuG9xqGHZP5dyu6pjI81
y3X92PnXl6vhQyGXn9wMpKC0onir14P2qCwXu4t85UGWL1BYYFSx49MCKThmgrqR
L5cQAJVyU/9xX/AcEgAxKA==
-----END PRIVATE KEY-----
`,
      private_key_id: 'test-key-id-not-real',
      project_id: 'vertex-test-project',
      token_uri: 'https://oauth2.googleapis.com/token',
      type: 'service_account',
    });

    try {
      await probe({
        keyVaults: {
          apiKey: fakeSa,
          region: 'us-central1',
        },
        model: 'gemini-1.5-flash',
        provider: {
          checkModel: 'gemini-1.5-flash',
          config: {},
          displayName: 'Vertex',
          enabled: true,
          fetchOnClient: false,
          id: 'p-vertex',
          providerKey: 'vertexai',
          revision: 0,
          settings: {},
          sort: 0,
          source: 'builtin',
          status: 'draft',
        } as never,
        runtimeProvider: 'vertexai',
      });
    } catch {
      // Expected: auth is denied by SafeOutbound transport; the hop must still be recorded.
    }

    expect(globalFetchCalls).toEqual([]);
    // Token exchange must hit SafeOutbound — empty safeCalls means a silent Node HTTP bypass.
    expect(safeCalls.length).toBeGreaterThan(0);
    expect(
      safeCalls.some(
        (u) =>
          u.includes('oauth2.googleapis.com') ||
          u.includes('accounts.google.com') ||
          u.includes('googleapis.com'),
      ),
    ).toBe(true);
    expect(JSON.stringify(safeCalls)).not.toContain('BEGIN PRIVATE KEY');
    expect(JSON.stringify(safeCalls)).not.toContain('vertex-test@example');
  });

  it('routes Bedrock through SafeOutbound-backed requestHandler without global fetch', async () => {
    const safeCalls: string[] = [];
    const transport = vi.fn(async (req) => {
      safeCalls.push(req.url.toString());
      return okJson({ completion: 'hi', stop_reason: 'end_turn' });
    });
    const outbound = createSafeOutboundHttpClient({
      resolve: async () => [{ address: '93.184.216.36', family: 4 }],
      transport,
    });
    const probe = createSafeAiConnectionProbe(outbound);

    try {
      await probe({
        keyVaults: {
          accessKeyId: 'AKIATESTNOTREAL',
          region: 'us-east-1',
          secretAccessKey: 'secret-test-not-real',
        },
        model: 'anthropic.claude-v2',
        provider: {
          checkModel: 'anthropic.claude-v2',
          config: {},
          displayName: 'Bedrock',
          enabled: true,
          fetchOnClient: false,
          id: 'p3',
          providerKey: 'bedrock',
          revision: 0,
          settings: {},
          sort: 0,
          source: 'builtin',
          status: 'draft',
        } as never,
        runtimeProvider: 'bedrock',
      });
    } catch {
      // Model-specific response shape may still throw; prove transport was used.
    }

    expect(globalFetchCalls).toEqual([]);
    expect(safeCalls.some((u) => u.includes('bedrock'))).toBe(true);
    expect(JSON.stringify(safeCalls)).not.toContain('secret-test-not-real');
    expect(JSON.stringify(safeCalls)).not.toContain('AKIATESTNOTREAL');
  });

  it('ensures every providerRuntimeMap constructor accepts an explicit fetch transport option', () => {
    // Exhaustive contract: constructors must not throw merely because `fetch` is supplied.
    // Providers that ignore it still run under runWithBoundFetch during connection tests.
    const fetchStub = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    const failures: string[] = [];

    for (const [id, Ctor] of Object.entries(providerRuntimeMap)) {
      try {
        // Minimal credentials per family — catch only TypeError/missing-option construction issues.
        void new (Ctor as new (options: Record<string, unknown>) => unknown)({
          accessKeyId: 'AKIATEST',
          accessKeySecret: 'secret',
          apiKey: 'test-key',
          baseURL: 'https://example.test/v1',
          fetch: fetchStub,
          region: 'us-east-1',
          secretAccessKey: 'secret',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Credential validation is fine; rejecting unknown `fetch` option is not.
        if (/unknown|unexpected|fetch is not|invalid option/i.test(message)) {
          failures.push(`${id}: ${message}`);
        }
      }
    }

    expect(failures).toEqual([]);
    // ModelRuntime still composes providers via initializeWithProvider.
    expect(typeof ModelRuntime.initializeWithProvider).toBe('function');
  });
});
