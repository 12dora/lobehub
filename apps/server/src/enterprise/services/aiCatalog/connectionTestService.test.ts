import { generateBrowserDeviceProfile } from '@lobechat/model-runtime/browserProfile';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformAiProviderItem } from '@/database/schemas/platform';

import { createSafeOutboundHttpClient } from '../../security/outboundHttp';
import {
  AiCatalogConnectionTestService,
  aiConnectionFailureCode,
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

/** Sentinel standing in for the browser-fingerprinted transport. */
const impersonatedFetch = vi.hoisted(() => vi.fn());
/** Sentinel standing in for the Cursor Agent CLI transport. */
const cursorAgentFetch = vi.hoisted(() => vi.fn());

vi.mock('../chatgptWeb/transport', () => ({ getChatGPTWebFetch: () => impersonatedFetch }));
vi.mock('../cursorAgent', () => ({ getCursorAgentFetch: () => cursorAgentFetch }));

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
      expect.objectContaining({
        fetch: expect.any(Function),
        managedBy: 'platform',
        maxRetries: 0,
      }),
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

describe('createSafeAiConnectionProbe ChatGPT Web transport', () => {
  const probe = () =>
    createSafeAiConnectionProbe(
      createSafeOutboundHttpClient({
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: vi.fn(),
      }),
    );

  /**
   * The SafeOutbound adapter is Node's own fetch underneath, and chatgpt.com answers that
   * TLS fingerprint with a Cloudflare challenge no matter which credentials are sent — a
   * probe through it would report a permanent auth failure for a working connection.
   */
  it('probes chatgptweb through the impersonated transport, streaming', async () => {
    chatMock.mockClear();
    initRuntimeMock.mockClear();
    chatMock.mockResolvedValueOnce(streamingResponse());
    const browserProfile = generateBrowserDeviceProfile({ seed: 'connection-test-profile' });

    await probe()({
      browserProfile,
      keyVaults: { oauthAccessToken: 'fake-token' },
      model: 'auto',
      provider: { ...provider, checkModel: 'auto', providerKey: 'chatgptweb' },
      runtimeProvider: 'chatgptweb',
    });

    const transport = initRuntimeMock.mock.calls[0][2] as Record<string, unknown>;
    // Wrapped, not raw: the child process has no deadline of its own (see below).
    expect(transport.fetch).not.toBe(impersonatedFetch);
    expect(transport.browserProfile).toBe(browserProfile);
    // Streaming-first backend + one honest attempt, same as the other subscription runtimes.
    expect(transport.maxRetries).toBe(0);
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'auto', stream: true }),
      expect.anything(),
    );
  });

  it('probes cursor through the CLI transport, streaming', async () => {
    chatMock.mockClear();
    initRuntimeMock.mockClear();
    chatMock.mockResolvedValueOnce(streamingResponse());

    await probe()({
      keyVaults: { oauthAccessToken: 'fake-token' },
      model: 'composer-2.5',
      provider: { ...provider, checkModel: 'composer-2.5', providerKey: 'cursor' },
      runtimeProvider: 'cursor',
    });

    const transport = initRuntimeMock.mock.calls[0][2] as Record<string, unknown>;
    expect(transport.fetch).not.toBe(cursorAgentFetch);
    expect(transport.fetch).not.toBe(impersonatedFetch);
    expect(transport.maxRetries).toBe(0);
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'composer-2.5', stream: true }),
      expect.anything(),
    );
  });

  /**
   * R2 §H2: the probe used to inject the browser profile for ChatGPT Web only, so an
   * admin's "test connection" on the platform Grok provider went out as a device id
   * compiled into the package — a different machine than the one chat presents.
   */
  it('forwards the installation profile to Grok and gives the probe its own conversation', async () => {
    chatMock.mockClear();
    initRuntimeMock.mockClear();
    chatMock.mockResolvedValueOnce(streamingResponse());
    const browserProfile = generateBrowserDeviceProfile({ seed: 'connection-test-profile' });

    await probe()({
      browserProfile,
      keyVaults: { oauthAccessToken: 'fake-token' },
      model: 'grok-4.6',
      provider: { ...provider, checkModel: 'grok-4.6', providerKey: 'grok' },
      runtimeProvider: 'grok',
    });

    const transport = initRuntimeMock.mock.calls[0][2] as Record<string, unknown>;
    expect(transport.browserProfile).toBe(browserProfile);
    expect(transport.conversationKey).toBe('platform:connection-test:grok');
  });

  it('leaves every other runtime on the enterprise outbound adapter', async () => {
    chatMock.mockClear();
    initRuntimeMock.mockClear();

    await probe()({
      keyVaults: { apiKey: 'fake-key' },
      model: 'gpt-test',
      provider: { ...provider, checkModel: 'gpt-test' },
      runtimeProvider: 'openai',
    });

    expect((initRuntimeMock.mock.calls[0][2] as Record<string, unknown>).fetch).not.toBe(
      impersonatedFetch,
    );
  });

  it('gives a missing transport binary its own stable code', () => {
    const failure = classifyAiConnectionFailure({
      code: 'CHATGPT_WEB_TRANSPORT_UNAVAILABLE',
      message: 'ChatGPT Web transport unavailable: the curl-impersonate binary was not found.',
      name: 'ChatGPTWebTransportUnavailableError',
    });

    expect(failure).toMatchObject({
      errorCategory: 'invalid_config',
      errorType: 'CHATGPT_WEB_TRANSPORT_UNAVAILABLE',
    });
    expect(aiConnectionFailureCode(failure.errorCategory, failure.errorType)).toBe(
      'connection_failed_transport',
    );
  });

  it('gives a missing Cursor Agent CLI its own stable code', () => {
    const failure = classifyAiConnectionFailure({
      code: 'cli_unavailable',
      message: 'Cursor Agent transport unavailable',
      name: 'CursorAgentUnavailableError',
    });

    expect(failure).toMatchObject({
      errorCategory: 'invalid_config',
      errorType: 'cli_unavailable',
    });
    expect(aiConnectionFailureCode(failure.errorCategory, failure.errorType)).toBe(
      'connection_failed_transport',
    );

    // Runtime wraps the 503 JSON body as ProviderBizError; the nested `code` still wins.
    const wrapped = classifyAiConnectionFailure({
      error: { code: 'cli_unavailable', message: 'cursor-agent missing', status: 503 },
      errorType: 'ProviderBizError',
      message: 'cursor-agent missing',
      provider: 'cursor',
    });
    expect(wrapped).toMatchObject({
      errorCategory: 'invalid_config',
      errorType: 'cli_unavailable',
    });
  });

  it('bounds the impersonated probe with the streaming connection-test deadline', async () => {
    chatMock.mockClear();
    initRuntimeMock.mockClear();
    impersonatedFetch.mockClear();
    impersonatedFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    chatMock.mockResolvedValueOnce(streamingResponse());

    await probe()({
      keyVaults: { oauthAccessToken: 'fake-token' },
      model: 'auto',
      provider: { ...provider, checkModel: 'auto', providerKey: 'chatgptweb' },
      runtimeProvider: 'chatgptweb',
    });

    const wrapped = (initRuntimeMock.mock.calls[0][2] as { fetch: typeof fetch }).fetch;
    const caller = new AbortController();
    await wrapped('https://chatgpt.com/backend-api/me', { signal: caller.signal });

    const init = impersonatedFetch.mock.calls[0][1] as RequestInit;
    expect(impersonatedFetch.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/me');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Composed, not replaced: cancelling the connection test still hangs up the child.
    expect(init.signal).not.toBe(caller.signal);
    caller.abort();
    expect(init.signal!.aborted).toBe(true);
  });

  /**
   * The deadline bounds the PROBE, not a hop. A ChatGPT Web chat is a sequence of requests
   * (bootstrap, sentinel prepare/finalize, conversation); a timer armed per fetch let one
   * "check" run for several multiples of the budget before any verdict appeared.
   */
  it('arms exactly one deadline per probe and shares it across every hop', async () => {
    chatMock.mockClear();
    initRuntimeMock.mockClear();
    impersonatedFetch.mockClear();
    impersonatedFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    chatMock.mockResolvedValueOnce(streamingResponse());

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      await probe()({
        keyVaults: { oauthAccessToken: 'fake-token' },
        model: 'auto',
        provider: { ...provider, checkModel: 'auto', providerKey: 'chatgptweb' },
        runtimeProvider: 'chatgptweb',
      });

      expect(timeoutSpy).toHaveBeenCalledTimes(1);

      // Two sequential hops on the same probe's transport: the deadline instance is reused,
      // so the second request inherits whatever is left of the budget rather than a fresh one.
      const wrapped = (initRuntimeMock.mock.calls[0][2] as { fetch: typeof fetch }).fetch;
      await wrapped('https://chatgpt.com/backend-api/sentinel/chat-requirements');
      await wrapped('https://chatgpt.com/backend-api/conversation');

      const first = (impersonatedFetch.mock.calls[0][1] as RequestInit).signal;
      const second = (impersonatedFetch.mock.calls[1][1] as RequestInit).signal;
      expect(first).toBeInstanceOf(AbortSignal);
      expect(second).toBe(first);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('passes the probe deadline into runtime.chat, not only into the transport', async () => {
    chatMock.mockClear();
    initRuntimeMock.mockClear();
    impersonatedFetch.mockClear();
    impersonatedFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let chatSignal: AbortSignal | undefined;
    let abortedDuringChat: boolean | undefined;

    chatMock.mockImplementationOnce(async (..._args: unknown[]) => {
      chatSignal = (_args[1] as { signal?: AbortSignal }).signal;
      // The runtime is still running when the probe budget runs out: the SDK call itself
      // must be cancelled, not just the next fetch it would have made.
      deadline.abort();
      abortedDuringChat = chatSignal?.aborted;
      return streamingResponse();
    });

    try {
      await probe()({
        keyVaults: { oauthAccessToken: 'fake-token' },
        model: 'auto',
        provider: { ...provider, checkModel: 'auto', providerKey: 'chatgptweb' },
        runtimeProvider: 'chatgptweb',
      });
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(chatSignal).toBeInstanceOf(AbortSignal);
    // Composed, not replaced: the probe's own hang-up still works (asserted elsewhere).
    expect(chatSignal).not.toBe(deadline.signal);
    expect(abortedDuringChat).toBe(true);
  });

  /**
   * The whole path, not a hand-built payload: the injected transport throws the real
   * `ChatGPTWebTransportUnavailableError`, the runtime wraps it the way model-runtime does
   * (`AgentRuntimeError.chat` with a generic outer `errorType`), and the probe's classifier
   * must still land on the transport code rather than "the provider rejected us".
   */
  describe('transport-unavailable through the probe', () => {
    const unavailable = () =>
      Object.assign(
        new Error('ChatGPT Web transport unavailable: the curl-impersonate binary was not found.'),
        { code: 'CHATGPT_WEB_TRANSPORT_UNAVAILABLE', name: 'ChatGPTWebTransportUnavailableError' },
      );

    const classifyProbeFailure = async (
      wrap: (error: unknown) => unknown,
    ): Promise<ReturnType<typeof classifyAiConnectionFailure>> => {
      initRuntimeMock.mockClear();
      impersonatedFetch.mockClear();
      impersonatedFetch.mockRejectedValue(unavailable());
      chatMock.mockImplementationOnce(async () => {
        try {
          const transport = initRuntimeMock.mock.calls[0][2] as { fetch: typeof fetch };
          return await transport.fetch('https://chatgpt.com/backend-api/conversation');
        } catch (error) {
          throw wrap(error);
        }
      });

      try {
        await probe()({
          keyVaults: { oauthAccessToken: 'fake-token' },
          model: 'auto',
          provider: { ...provider, checkModel: 'auto', providerKey: 'chatgptweb' },
          runtimeProvider: 'chatgptweb',
        });
      } catch (error) {
        return classifyAiConnectionFailure(error);
      }
      throw new Error('probe unexpectedly succeeded');
    };

    it.each([
      [
        'wrapped in the runtime payload',
        (error: unknown) => ({
          error: {
            code: (error as { code: string }).code,
            kind: 'transport_unavailable',
            message: (error as Error).message,
          },
          errorType: 'ProviderBizError',
          message: (error as Error).message,
          provider: 'chatgptweb',
        }),
      ],
      ['re-thrown unwrapped', (error: unknown) => error],
    ])('resolves to connection_failed_transport (%s)', async (_label, wrap) => {
      const failure = await classifyProbeFailure(wrap);

      expect(failure.errorType).toBe('CHATGPT_WEB_TRANSPORT_UNAVAILABLE');
      expect(failure.errorCategory).toBe('invalid_config');
      expect(aiConnectionFailureCode(failure.errorCategory, failure.errorType)).toBe(
        'connection_failed_transport',
      );
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
