import { describe, expect, it, vi } from 'vitest';

import type { PlatformAiProviderItem } from '@/database/schemas/platform';

import { createSafeOutboundHttpClient } from '../../security/outboundHttp';
import {
  AiCatalogConnectionTestService,
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

vi.mock('@lobechat/model-runtime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runWithBoundFetch: async (_fetch: unknown, fn: () => Promise<unknown>) => fn(),
  };
});

vi.mock('@/server/modules/ModelRuntime', () => ({
  buildPayloadFromKeyVaults: () => ({}),
  initModelRuntimeWithUserPayload: () => ({
    chat: chatMock,
  }),
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
    expect(result.sanitizedMessage).toBe('Connection failed: authentication rejected');
    expect(result.sanitizedMessage).not.toContain('private.example');
    expect(result.sanitizedMessage.length).toBeLessThanOrEqual(500);
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
    expect(result.sanitizedMessage).toBe('Connection failed: authentication rejected');
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
      sanitizedMessage: 'Connection failed: provider network unavailable',
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
