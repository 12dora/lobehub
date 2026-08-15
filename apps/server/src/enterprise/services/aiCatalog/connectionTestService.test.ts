import { describe, expect, it, vi } from 'vitest';

import type { PlatformAiProviderItem } from '@/database/schemas/platform';

import { createSafeOutboundHttpClient } from '../../security/outboundHttp';
import {
  AiCatalogConnectionTestService,
  classifyAiConnectionFailure,
  createSafeAiConnectionProbe,
  resolveAiConnectionProbeApiMode,
} from './connectionTestService';

/** A real, non-empty SSE body — a streaming probe must actually receive completion bytes. */
const streamingResponse = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n'));
        controller.close();
      },
    }),
    { status: 200 },
  );

const chatMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 })),
);

/** Captures the runtime init options so transport/retry wiring is assertable. */
const initRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock('@lobechat/model-runtime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runWithBoundFetch: async (_fetch: unknown, fn: () => Promise<unknown>) => fn(),
  };
});

vi.mock('@/server/modules/ModelRuntime', () => ({
  buildPayloadFromKeyVaults: () => ({}),
  initModelRuntimeWithUserPayload: (...args: unknown[]) => {
    initRuntimeMock(...args);
    return { chat: chatMock };
  },
  resolveManagedChatApiMode: (enableResponseApi: unknown) => {
    if (enableResponseApi === true) return 'responses';
    if (enableResponseApi === false) return 'chatCompletion';
    return undefined;
  },
}));

const provider = {
  checkModel: 'test-model',
  config: {},
  displayName: 'Alpha',
  enabled: true,
  fetchOnClient: false,
  id: 'provider-1',
  providerKey: 'alpha',
  revision: 0,
  settings: {},
  sort: 0,
  source: 'custom',
  status: 'draft',
} as PlatformAiProviderItem;

describe('resolveAiConnectionProbeApiMode', () => {
  it('forwards explicit enableResponseApi to responses / chatCompletion apiMode', () => {
    expect(resolveAiConnectionProbeApiMode(true)).toBe('responses');
    expect(resolveAiConnectionProbeApiMode(false)).toBe('chatCompletion');
    expect(resolveAiConnectionProbeApiMode(undefined)).toBeUndefined();
    expect(resolveAiConnectionProbeApiMode(null)).toBeUndefined();
  });
});

describe('createSafeAiConnectionProbe streaming drain', () => {
  const streamingProvider = {
    ...provider,
    checkModel: 'gpt-5.5',
    providerKey: 'chatgpt',
  } as PlatformAiProviderItem;
  const runStreamingProbe = () =>
    createSafeAiConnectionProbe(
      createSafeOutboundHttpClient({
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: vi.fn(),
      }),
    )({
      keyVaults: { oauthAccessToken: 'fake-token' },
      model: 'gpt-5.5',
      provider: streamingProvider,
      runtimeProvider: 'chatgpt',
    });

  it('fails a streaming probe whose response carries no body at all', async () => {
    // A 200 with no body is not a completion. Treating it as success reduced the probe to a
    // status-code check and let a broken subscription backend look healthy.
    chatMock.mockClear();
    chatMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(runStreamingProbe()).rejects.toThrow(/empty completion stream/);
  });

  it('fails a streaming probe whose stream yields zero bytes', async () => {
    chatMock.mockClear();
    chatMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => controller.close(),
        }),
        { status: 200 },
      ),
    );
    await expect(runStreamingProbe()).rejects.toThrow(/empty completion stream/);
  });

  it('passes when the stream actually delivers completion bytes', async () => {
    chatMock.mockClear();
    chatMock.mockResolvedValueOnce(streamingResponse());
    await expect(runStreamingProbe()).resolves.toBeUndefined();
  });

  it('resolves on the FIRST chunk and cancels the body instead of reading to the end', async () => {
    // The verdict a connectivity probe owes is "the provider accepted us and started
    // producing". Reading to `done` paid for the model's whole completion — for a reasoning
    // model that is tens of seconds, which is exactly what made the admin check time out.
    chatMock.mockClear();
    let cancelled = false;
    let chunks = 0;
    const neverEndingStream = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      pull: (controller) => {
        chunks += 1;
        controller.enqueue(new TextEncoder().encode(`data: {"delta":"${chunks}"}\n\n`));
        // Never closes: only a first-byte verdict can finish this probe.
      },
    });
    chatMock.mockResolvedValueOnce(new Response(neverEndingStream, { status: 200 }));

    await expect(runStreamingProbe()).resolves.toBeUndefined();
    expect(cancelled).toBe(true);
    expect(chunks).toBeLessThanOrEqual(2);
  });

  it('gives the streaming probe one attempt on a streaming transport, not the SDK retry default', async () => {
    initRuntimeMock.mockClear();
    chatMock.mockClear();
    chatMock.mockResolvedValueOnce(streamingResponse());
    await runStreamingProbe();

    expect(initRuntimeMock).toHaveBeenCalledWith(
      'chatgpt',
      expect.anything(),
      expect.objectContaining({ fetch: expect.any(Function), maxRetries: 0 }),
    );
  });

  it('leaves non-streaming probes on the SDK retry default (api-key providers unchanged)', async () => {
    initRuntimeMock.mockClear();
    chatMock.mockClear();
    await createSafeAiConnectionProbe(
      createSafeOutboundHttpClient({
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: vi.fn(),
      }),
    )({
      keyVaults: { apiKey: 'fake-key' },
      model: 'gpt-test',
      provider,
      runtimeProvider: 'openai',
    });

    const options = initRuntimeMock.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty('maxRetries');
  });
});

describe('classifyAiConnectionFailure', () => {
  /**
   * The shape the model-runtime REALLY throws: `AgentRuntimeError.chat` returns a plain object
   * (not an `Error`) with no top-level `status`. Classifying on `error instanceof Error` /
   * `'status' in error` made every OpenAI-compatible failure collapse into `provider`, so a
   * dead OAuth grant, a 429 and a transport timeout all printed the same sentence.
   */
  const runtimePayload = (payload: Record<string, unknown>) => ({
    endpoint: 'https://chatgpt.com/backend-api/codex',
    provider: 'chatgpt',
    ...payload,
  });

  it('reads a nested 401 payload as auth', () => {
    expect(
      classifyAiConnectionFailure(
        runtimePayload({
          error: { headers: {}, status: 401 },
          errorType: 'InvalidProviderAPIKey',
        }),
      ),
    ).toEqual({ errorCategory: 'auth', errorType: 'InvalidProviderAPIKey', status: 401 });
  });

  it('reads an expired shared grant as auth', () => {
    expect(
      classifyAiConnectionFailure(runtimePayload({ errorType: 'OAuthAuthorizationExpired' })),
    ).toMatchObject({ errorCategory: 'auth', errorType: 'OAuthAuthorizationExpired' });
  });

  it('reads a rate-limit errorType with no status as rate_limit', () => {
    expect(
      classifyAiConnectionFailure(
        runtimePayload({
          error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' },
          errorType: 'RateLimitExceeded',
          message: '429 Rate limit reached',
        }),
      ),
    ).toMatchObject({ errorCategory: 'rate_limit', errorType: 'RateLimitExceeded' });
  });

  it('reads an APIConnectionTimeoutError-shaped payload as network', () => {
    expect(
      classifyAiConnectionFailure(
        runtimePayload({
          error: {
            cause: undefined,
            message: 'Request timed out.',
            name: 'APIConnectionTimeoutError',
          },
          errorType: 'ProviderBizError',
          message: 'Request timed out.',
        }),
      ),
    ).toMatchObject({ errorCategory: 'network', errorType: 'ProviderBizError' });
  });

  it('reads an aborted DOMException as network', () => {
    expect(
      classifyAiConnectionFailure(new DOMException('The operation was aborted', 'AbortError')),
    ).toMatchObject({ errorCategory: 'network' });
  });

  it('reads a wrapped AbortError cause as network', () => {
    expect(
      classifyAiConnectionFailure(
        runtimePayload({
          error: { message: 'The operation was aborted', name: 'AbortError' },
          errorType: 'ProviderBizError',
        }),
      ),
    ).toMatchObject({ errorCategory: 'network' });
  });

  it('keeps a plain provider 400 in the provider bucket', () => {
    expect(
      classifyAiConnectionFailure(
        runtimePayload({
          error: { message: 'Unsupported parameter: store', type: 'invalid_request_error' },
          errorType: 'ProviderBizError',
          message: '400 Unsupported parameter: store',
        }),
      ),
    ).toMatchObject({ errorCategory: 'provider', errorType: 'ProviderBizError' });
  });

  it('drops runtime codes that are not on the contract allowlist', () => {
    expect(classifyAiConnectionFailure(runtimePayload({ errorType: 'SomeBrandNewCode' }))).toEqual({
      errorCategory: 'provider',
      status: 0,
    });
  });

  it('still classifies legacy Error{status} shapes from api-key runtimes', () => {
    const error = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(classifyAiConnectionFailure(error)).toMatchObject({
      errorCategory: 'auth',
      status: 401,
    });
  });
});

describe('AiCatalogConnectionTestService', () => {
  it('createSafeAiConnectionProbe forwards apiMode responses and chatCompletion to runtime.chat', async () => {
    chatMock.mockClear();
    const probe = createSafeAiConnectionProbe(
      createSafeOutboundHttpClient({
        resolve: async () => [{ address: '203.0.113.10', family: 4 }],
        transport: vi.fn(),
      }),
    );

    chatMock.mockResolvedValueOnce(streamingResponse());
    await probe({
      keyVaults: { apiKey: 'fake-key' },
      model: 'gpt-test',
      provider: {
        ...provider,
        checkModel: 'gpt-test',
        config: { enableResponseApi: true },
      } as PlatformAiProviderItem,
      runtimeProvider: 'openai',
    });
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiMode: 'responses', model: 'gpt-test', stream: true }),
      expect.anything(),
    );

    chatMock.mockClear();
    await probe({
      keyVaults: { apiKey: 'fake-key' },
      model: 'gpt-test',
      provider: {
        ...provider,
        checkModel: 'gpt-test',
        config: { enableResponseApi: false },
      } as PlatformAiProviderItem,
      runtimeProvider: 'openai',
    });
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiMode: 'chatCompletion', model: 'gpt-test', stream: false }),
      expect.anything(),
    );

    // Responses-only runtimes (Codex/xAI subscription backends) are streaming-first: probing
    // them non-streaming would take a transport production never uses.
    chatMock.mockClear();
    chatMock.mockResolvedValueOnce(streamingResponse());
    await probe({
      keyVaults: { oauthAccessToken: 'fake-token' },
      model: 'gpt-5.5',
      provider: {
        ...provider,
        checkModel: 'gpt-5.5',
        config: {},
        providerKey: 'chatgpt',
      } as PlatformAiProviderItem,
      runtimeProvider: 'chatgpt',
    });
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.5', stream: true }),
      expect.anything(),
    );

    chatMock.mockClear();
    await probe({
      keyVaults: { apiKey: 'fake-key' },
      model: 'gpt-test',
      provider: {
        ...provider,
        checkModel: 'gpt-test',
        config: {},
      } as PlatformAiProviderItem,
      runtimeProvider: 'openai',
    });
    expect(chatMock).toHaveBeenCalled();
    const lastCall = chatMock.mock.calls.at(-1);
    const payload = lastCall?.[0] as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty('apiMode');
  });

  it('returns only bounded status metadata on success', async () => {
    const service = new AiCatalogConnectionTestService(async () => {});
    const result = await service.test({
      keyVaults: { apiKey: 'fake-key' },
      model: 'gpt-test',
      provider,
      runtimeProvider: 'openai',
    });
    expect(result).toMatchObject({ errorCategory: null, status: 'success' });
    expect(result.testedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(result)).not.toContain('fake-key');
  });

  it('classifies and sanitizes failures without URL or credential leakage', async () => {
    const service = new AiCatalogConnectionTestService(async () => {
      const error = new Error('Unauthorized sk-fake-not-real-123456 at https://private.example/v1');
      Object.assign(error, { status: 401 });
      throw error;
    });
    const result = await service.test({
      keyVaults: { apiKey: 'fake-key' },
      model: 'gpt-test',
      provider,
      runtimeProvider: 'openai',
    });
    expect(result).toMatchObject({ errorCategory: 'auth', status: 'failure' });
    // Stable code, not prose: the admin checker translates it (`llm.checker.reason.*`).
    expect(result.sanitizedMessage).toBe('connection_failed_auth');
    expect(result.sanitizedMessage).not.toContain('private.example');
    expect(result.sanitizedMessage.length).toBeLessThanOrEqual(500);
  });

  it('gives a dead shared grant its own code so a superseded replay stays actionable', async () => {
    // Only `sanitizedMessage` is persisted with the connection test, so a CAS-losing concurrent
    // attempt replays the code and nothing else. Folding this into the generic `auth` code left
    // the second admin tab telling the operator to check an API key that does not exist.
    const service = new AiCatalogConnectionTestService(async () => {
      throw {
        error: { message: 'The shared provider connection has expired' },
        errorType: 'OAuthAuthorizationExpired',
      };
    });
    const result = await service.test({
      keyVaults: { oauthAccessToken: 'fake-token' },
      model: 'gpt-5.5',
      provider,
      runtimeProvider: 'chatgpt',
    });
    expect(result).toMatchObject({
      errorCategory: 'auth',
      errorType: 'OAuthAuthorizationExpired',
      sanitizedMessage: 'connection_failed_shared_account_expired',
      status: 'failure',
    });
    expect(JSON.stringify(result)).not.toContain('shared provider connection has expired');
  });

  it('never reflects structured credential leaves from arbitrary provider errors', async () => {
    const keyVaults = {
      apiKey: 'plain-multi-field-key',
      customHeaders: { Authorization: 'plain-header-secret' },
      password: 'plain-password',
    };
    const service = new AiCatalogConnectionTestService(async () => {
      throw new Error(JSON.stringify(keyVaults));
    });
    const result = await service.test({
      keyVaults,
      model: 'gpt-test',
      provider,
      runtimeProvider: 'comfyui',
    });
    expect(result.sanitizedMessage).toBe('connection_failed_auth');
    expect(JSON.stringify(result)).not.toContain('plain-multi-field-key');
    expect(JSON.stringify(result)).not.toContain('plain-header-secret');
    expect(JSON.stringify(result)).not.toContain('plain-password');
  });

  it('classifies enterprise outbound policy denials as network failures', async () => {
    const service = new AiCatalogConnectionTestService(async () => {
      throw new Error('Outbound request blocked by enterprise network policy');
    });
    const result = await service.test({
      keyVaults: { apiKey: 'fake-key' },
      model: 'gpt-test',
      provider,
      runtimeProvider: 'openai',
    });
    expect(result).toMatchObject({
      errorCategory: 'network',
      sanitizedMessage: 'connection_failed_network',
      status: 'failure',
    });
  });

  it('builds the production probe against SafeOutboundHttpClient rather than raw fetch', () => {
    const transport = vi.fn();
    const outbound = createSafeOutboundHttpClient({
      resolve: async () => [{ address: '203.0.113.10', family: 4 }],
      transport,
    });
    const probe = createSafeAiConnectionProbe(outbound);
    expect(typeof probe).toBe('function');
    // Probe is bound to the injected SafeOutbound client; production never accepts raw fetch.
    expect(probe.length).toBe(1);
  });
});
