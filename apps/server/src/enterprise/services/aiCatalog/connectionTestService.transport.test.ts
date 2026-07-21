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
      resolve: async () => [{ address: '203.0.113.10', family: 4 }],
      transport,
    });
    const probe = createSafeAiConnectionProbe(outbound);

    await probe({
      keyVaults: { apiKey: 'sk-test-not-real' },
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
      resolve: async () => [{ address: '203.0.113.20', family: 4 }],
      transport,
    });
    const probe = createSafeAiConnectionProbe(outbound);

    try {
      await probe({
        keyVaults: { apiKey: 'google-test-key-not-real' },
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

  it('routes Bedrock through SafeOutbound-backed requestHandler without global fetch', async () => {
    const safeCalls: string[] = [];
    const transport = vi.fn(async (req) => {
      safeCalls.push(req.url.toString());
      return okJson({ completion: 'hi', stop_reason: 'end_turn' });
    });
    const outbound = createSafeOutboundHttpClient({
      resolve: async () => [{ address: '203.0.113.30', family: 4 }],
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
