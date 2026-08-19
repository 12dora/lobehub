import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BROWSER_DEVICE_PROFILE, resolveProfileTimezone } from '../../browserProfile';
import { ChatGPTWebClient } from './client';
import { SentinelBundlePool } from './sentinelBundlePool';
import { createMemoryChatGPTWebSessionContext } from './sessionContext';
import type { ChatRequirements } from './types';

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
    ...init,
  });

const sseResponse = (payloads: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const payload of payloads) controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' }, status: 200 },
  );

/** An SSE leg that streams a few payloads and then the connection breaks. */
const brokenSseResponse = (payloads: string[]) => {
  let index = 0;
  return new Response(
    // one payload per pull, so the consumer really sees them before the break
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= payloads.length) {
          controller.error(new Error('connection reset'));
          return;
        }
        controller.enqueue(new TextEncoder().encode(`data: ${payloads[index]}\n\n`));
        index += 1;
      },
    }),
    { headers: { 'content-type': 'text/event-stream' }, status: 200 },
  );
};

const requirements: ChatRequirements = {
  proofToken: 'gAAAAABproof',
  soToken: 'so-token',
  token: 'requirements-token',
  turnstileToken: 'turnstile-token',
};

let fetchMock: ReturnType<typeof vi.fn>;

const createClient = (options: Partial<ConstructorParameters<typeof ChatGPTWebClient>[0]> = {}) =>
  new ChatGPTWebClient({
    accessToken: 'access-token',
    deviceId: 'device-1',
    fetch: fetchMock as unknown as typeof fetch,
    sessionId: 'session-1',
    ...options,
  });

const callAt = (index: number) => ({
  headers: fetchMock.mock.calls[index][1].headers as Record<string, string>,
  init: fetchMock.mock.calls[index][1] as RequestInit,
  url: fetchMock.mock.calls[index][0] as string,
});

beforeEach(() => {
  fetchMock = vi.fn();
});

describe('ChatGPTWebClient headers', () => {
  it('sends the session fingerprint and target path/route on every call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ email: 'a@b.co', id: 'user-1' }));

    const me = await createClient().getMe();

    expect(me).toMatchObject({ email: 'a@b.co', id: 'user-1' });
    const { headers, url } = callAt(0);
    expect(url).toBe('https://chatgpt.com/backend-api/me');
    expect(headers['Authorization']).toBe('Bearer access-token');
    expect(headers['OAI-Device-Id']).toBe('device-1');
    expect(headers['OAI-Session-Id']).toBe('session-1');
    expect(headers['X-OpenAI-Target-Path']).toBe('/backend-api/me');
    expect(headers['X-OpenAI-Target-Route']).toBe('/backend-api/me');
    expect(headers['User-Agent']).toBe(DEFAULT_BROWSER_DEVICE_PROFILE.userAgent);
    expect(headers['Sec-Ch-Ua']).toBe(DEFAULT_BROWSER_DEVICE_PROFILE.secChUa);
    expect(headers['OAI-Language']).toBe(DEFAULT_BROWSER_DEVICE_PROFILE.oaiLanguage);
  });

  it('keeps the query string out of the target path headers', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        accounts: { default: { account: { account_id: 'acc-1', plan_type: 'plus' } } },
      }),
    );

    const result = await createClient().getAccountsCheck();

    expect(result).toMatchObject({ accountId: 'acc-1', planType: 'plus' });
    const { headers, url } = callAt(0);
    expect(url).toBe(
      `https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?timezone_offset_min=${resolveProfileTimezone(DEFAULT_BROWSER_DEVICE_PROFILE).offsetMinutes}`,
    );
    expect(headers['X-OpenAI-Target-Path']).toBe('/backend-api/accounts/check/v4-2023-04-27');
  });

  it('sends the templated route when reading a conversation', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ mapping: {} }));

    await createClient().getConversation('conv-1');

    const { headers } = callAt(0);
    expect(headers['X-OpenAI-Target-Path']).toBe('/backend-api/conversation/conv-1');
    expect(headers['X-OpenAI-Target-Route']).toBe('/backend-api/conversation/{conversation_id}');
    expect(headers['Referer']).toBe('https://chatgpt.com/c/conv-1');
  });
});

describe('ChatGPTWebClient.hideConversation', () => {
  it('patches is_visible false with the templated route', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    await createClient().hideConversation('conv-1');

    const { headers, init } = callAt(0);
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('{"is_visible":false}');
    expect(headers['X-OpenAI-Target-Route']).toBe('/backend-api/conversation/{conversation_id}');
  });

  it('never throws when the upstream rejects it', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(createClient().hideConversation('conv-1')).resolves.toBeUndefined();
  });
});

describe('ChatGPTWebClient.uploadFile', () => {
  it('runs the three-step upload', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          file_id: 'file_1',
          library_file_id: 'lib_1',
          upload_url: 'https://oaiusercontent.blob.core.windows.net/signed',
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({ status: 'success' }));

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const ref = await createClient().uploadFile(bytes, {
      height: 8,
      kind: 'image',
      mimeType: 'image/png',
      name: 'image_1.png',
      width: 8,
    });

    expect(ref).toEqual({
      fileId: 'file_1',
      height: 8,
      kind: 'image',
      libraryFileId: 'lib_1',
      mimeType: 'image/png',
      name: 'image_1.png',
      size: 4,
      width: 8,
    });

    const create = callAt(0);
    expect(create.url).toBe('https://chatgpt.com/backend-api/files');
    expect(JSON.parse(create.init.body as string)).toMatchObject({
      file_size: 4,
      use_case: 'multimodal',
    });

    const put = callAt(1);
    expect(put.url).toBe('https://oaiusercontent.blob.core.windows.net/signed');
    expect(put.init.method).toBe('PUT');
    expect(put.headers['x-ms-blob-type']).toBe('BlockBlob');
    expect(put.headers['x-ms-version']).toBe('2020-04-08');
    expect(put.headers['Content-Type']).toBe('image/png');
    expect(put.headers['Authorization']).toBeUndefined();

    const confirm = callAt(2);
    expect(confirm.url).toBe('https://chatgpt.com/backend-api/files/file_1/uploaded');
    expect(confirm.init.body).toBe('{}');
  });

  it('fails loudly when the upstream returns no upload url', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ file_id: 'file_1' }));

    await expect(
      createClient().uploadFile(new Uint8Array([1]), {
        kind: 'document',
        mimeType: 'application/pdf',
        name: 'a.pdf',
      }),
    ).rejects.toMatchObject({ kind: 'upstream' });
  });
});

describe('ChatGPTWebClient error classification', () => {
  it.each([
    [401, '{"detail":"expired"}', {}, 'auth'],
    [403, '<html>Just a moment…</html>', {}, 'cloudflare'],
    [403, '{"detail":"nope"}', { 'content-type': 'application/json' }, 'permission'],
    [404, '{}', {}, 'not_found'],
    [429, '{}', { 'retry-after': '0' }, 'rate_limit'],
    [500, 'boom', {}, 'upstream'],
  ])('maps HTTP %s to %s', async (status, body, headers, kind) => {
    fetchMock.mockResolvedValue(new Response(body, { headers, status }));

    await expect(createClient().getMe()).rejects.toMatchObject({ kind, status });
  });

  it('maps transport failures to network errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(createClient().getMe()).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('ChatGPTWebClient.getChatRequirements', () => {
  it('bootstraps, solves the challenges and finalizes', async () => {
    fetchMock
      // bootstrap is Cloudflare-challenged — we fall back to the default script
      .mockResolvedValueOnce(new Response('<html>nope</html>', { status: 403 }))
      .mockResolvedValueOnce(
        jsonResponse({
          arkose: { required: false },
          prepare_token: 'prepare-1',
          proofofwork: { difficulty: 'ffff', required: true, seed: 'seed-1' },
          turnstile: { required: false },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ so_token: 'so-1', token: 'req-1' }));

    const result = await createClient().getChatRequirements();

    expect(result).toMatchObject({ soToken: 'so-1', token: 'req-1', turnstileToken: '' });
    expect(result.proofToken.startsWith('gAAAAAB')).toBe(true);

    const prepare = callAt(1);
    expect(prepare.url).toBe('https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare');
    expect(JSON.parse(prepare.init.body as string).p.startsWith('gAAAAAC')).toBe(true);

    const finalize = callAt(2);
    expect(finalize.url).toBe(
      'https://chatgpt.com/backend-api/sentinel/chat-requirements/finalize',
    );
    const finalizeBody = JSON.parse(finalize.init.body as string) as Record<string, unknown>;
    expect(Object.keys(finalizeBody)).toEqual(['prepare_token', 'proofofwork', 'turnstile']);
    expect(finalizeBody).toMatchObject({
      prepare_token: 'prepare-1',
      turnstile: '',
    });
    expect(typeof finalizeBody.proofofwork).toBe('string');
    expect((finalizeBody.proofofwork as string).startsWith('gAAAAAB')).toBe(true);
    expect(finalizeBody).not.toHaveProperty('proof_token');
    expect(finalizeBody).not.toHaveProperty('turnstile_token');
  });

  it('rejects with an arkose error when the upstream asks for one', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('<html></html>', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ arkose: { required: true }, prepare_token: 'x' }));

    await expect(createClient().getChatRequirements()).rejects.toMatchObject({ kind: 'arkose' });
  });

  it('rejects when finalize returns no token', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('<html></html>', { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ prepare_token: 'x' }))
      .mockResolvedValueOnce(jsonResponse({}));

    await expect(createClient().getChatRequirements()).rejects.toMatchObject({ kind: 'upstream' });
  });
});

const mockSentinelHandshake = (token: string, expireAt = Math.floor(Date.now() / 1000) + 540) => {
  fetchMock
    .mockResolvedValueOnce(new Response('<html></html>', { status: 200 }))
    .mockResolvedValueOnce(
      jsonResponse({
        prepare_token: `prepare-${token}`,
        proofofwork: { difficulty: 'ffff', required: true, seed: `seed-${token}` },
        turnstile: { required: false },
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({ expire_after: 540, expire_at: expireAt, so_token: `so-${token}`, token }),
    );
  return expireAt;
};

describe('ChatGPTWebClient.acquireSentinelBundle', () => {
  it('returns a warmed bundle without a same-turn handshake', async () => {
    const pool = new SentinelBundlePool();
    const client = createClient({ sentinelBundlePool: pool });
    const expireAt = mockSentinelHandshake('warm');

    await client.warmSentinelBundle({ contextKey: 'ctx-1' });
    const acquired = await client.acquireSentinelBundle({ contextKey: 'ctx-1' });

    expect(acquired.requirements.token).toBe('warm');
    expect(acquired.expiresAtMs).toBe(expireAt * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('replenishes a distinct bundle after acquire', async () => {
    const pool = new SentinelBundlePool();
    const client = createClient({ sentinelBundlePool: pool });
    mockSentinelHandshake('a');
    // bootstrap is cached on the client; the next handshake is prepare + finalize
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          prepare_token: 'prepare-b',
          proofofwork: { difficulty: 'ffff', required: true, seed: 'seed-b' },
          turnstile: { required: false },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ expire_after: 540, so_token: 'so-b', token: 'b' }));

    const first = await client.acquireSentinelBundle({ contextKey: 'ctx-1' });
    client.replenishSentinelBundle({ contextKey: 'ctx-1' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    const second = await client.acquireSentinelBundle({ contextKey: 'ctx-1' });

    expect(first.requirements.token).toBe('a');
    expect(second.requirements.token).toBe('b');
    expect(first.id).not.toBe(second.id);
  });
});

describe('ChatGPTWebClient bootstrap cache on Browser Session Context', () => {
  it('reuses scraped build markers across reconstructed clients for the same context', async () => {
    const sessionContext = createMemoryChatGPTWebSessionContext({
      contextId: 'ctx-account-a',
      cookieJarKey: 'ctx:jar-a',
      logicalPageId: '11111111-1111-4111-8111-111111111111',
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response('<html data-build="prod-livebuild"><b>build_number\\":424242.0</b></html>', {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ prepare_token: 'prep-1' }))
      .mockResolvedValueOnce(jsonResponse({ so_token: 'so-1', token: 'req-1' }))
      .mockResolvedValueOnce(jsonResponse({ prepare_token: 'prep-2' }))
      .mockResolvedValueOnce(jsonResponse({ so_token: 'so-2', token: 'req-2' }));

    await createClient({ sessionContext }).getChatRequirements();
    await createClient({ sessionContext }).getChatRequirements();

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const secondPrepareHeaders = fetchMock.mock.calls[3][1].headers as Record<string, string>;
    expect(secondPrepareHeaders['OAI-Client-Version']).toBe('prod-livebuild');
    expect(secondPrepareHeaders['OAI-Client-Build-Number']).toBe('424242');
    expect(secondPrepareHeaders['OAI-Session-Id']).toBe(sessionContext.logicalPageId);
  });

  it('does not cache an unauthenticated /unauth-mweb/ bootstrap on the context', async () => {
    const sessionContext = createMemoryChatGPTWebSessionContext({
      contextId: 'ctx-cold',
      cookieJarKey: 'ctx:jar-cold',
      logicalPageId: '22222222-2222-4222-8222-222222222222',
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          '<html data-build="prod-unauth"><script src="/unauth-mweb/assets/client.js"></script><b>build_number:1111111</b></html>',
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ prepare_token: 'prep-unauth' }))
      .mockResolvedValueOnce(jsonResponse({ so_token: 'so-unauth', token: 'req-unauth' }))
      .mockResolvedValueOnce(
        new Response('<html data-build="prod-livebuild"><b>build_number\\":424242.0</b></html>', {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ prepare_token: 'prep-auth' }))
      .mockResolvedValueOnce(jsonResponse({ so_token: 'so-auth', token: 'req-auth' }));

    await createClient({ sessionContext }).getChatRequirements();
    expect(sessionContext.getBootstrap()).toBeUndefined();

    await createClient({ sessionContext }).getChatRequirements();
    expect(sessionContext.getBootstrap()?.clientVersion).toBe('prod-livebuild');
    expect(sessionContext.getBootstrap()?.clientBuildNumber).toBe('424242');
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const secondBootstrap = fetchMock.mock.calls[3][0] as string;
    expect(secondBootstrap).toBe('https://chatgpt.com/');
    const secondPrepareHeaders = fetchMock.mock.calls[4][1].headers as Record<string, string>;
    expect(secondPrepareHeaders['OAI-Client-Version']).toBe('prod-livebuild');
    expect(secondPrepareHeaders['OAI-Client-Build-Number']).toBe('424242');
  });

  it('setBootstrap on an invalidated sessionContext handle is ignored', async () => {
    let writable = true;
    let bootstrap: { clientVersion?: string } | undefined;
    const sessionContext = {
      contextId: 'ctx-dead',
      cookieJarKey: 'ctx:jar-dead',
      getBootstrap: () => (writable ? bootstrap : undefined),
      logicalPageId: '33333333-3333-4333-8333-333333333333',
      setBootstrap: (state: { clientVersion?: string }) => {
        if (!writable) return;
        bootstrap = state;
      },
    };
    fetchMock
      .mockResolvedValueOnce(
        new Response('<html data-build="prod-livebuild"><b>build_number\\":424242.0</b></html>', {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ prepare_token: 'prep-1' }))
      .mockResolvedValueOnce(jsonResponse({ so_token: 'so-1', token: 'req-1' }));

    writable = false;
    await createClient({ sessionContext }).getChatRequirements();
    expect(sessionContext.getBootstrap()).toBeUndefined();
  });
});

describe('ChatGPTWebClient.prepareConversation', () => {
  it('reads the conduit token and sends the browser turn lifecycle headers', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ conduit_token: 'conduit-1' }));
    const turnIdentity = {
      observationId: 'abcdefghijklmnop',
      traceId: '11111111-1111-4111-8111-111111111111',
    };

    const result = await createClient().prepareConversation(
      { action: 'next' },
      { requirements, turnIdentity },
    );

    expect(result).toEqual({ conduitToken: 'conduit-1' });
    const { headers, url } = callAt(0);
    expect(url).toBe('https://chatgpt.com/backend-api/f/conversation/prepare');
    expect(headers['Accept']).toBe('*/*');
    expect(headers['X-Oai-Turn-Trace-Id']).toBe(turnIdentity.traceId);
    expect(headers['X-Oai-Is-Client-Observation']).toBe(`v1.r.p.${turnIdentity.observationId}`);
    expect(headers['OpenAI-Sentinel-Chat-Requirements-Token']).toBeUndefined();
    expect(headers['OpenAI-Sentinel-Proof-Token']).toBeUndefined();
    expect(headers['OpenAI-Sentinel-Turnstile-Token']).toBeUndefined();
  });

  it('still emits a fresh turn lifecycle when the caller supplies none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ conduit_token: 'conduit-1' }));

    await createClient().prepareConversation({ action: 'next' });

    expect(callAt(0).headers['X-Conduit-Token']).toBeUndefined();
    expect(callAt(0).headers['X-Oai-Turn-Trace-Id']).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
    );
    expect(callAt(0).headers['X-Oai-Is-Client-Observation']).toMatch(/^v1\.r\.p\.[\w-]{16}$/u);
  });

  // `{status:"ok", conduit_token:null}` (and equivalent missing/blank/malformed
  // token shapes) is a NORMAL prepare response, not a failure — verified against
  // a captured real Chrome session (2026-08-19): the browser gets the same null
  // token for a Pro-tier turn and just proceeds via the conduit path with no
  // `X-Conduit-Token` header. Throwing here (the old behavior) is what silently
  // demoted those turns to the legacy endpoint and substituted a mini answer.
  it.each([
    ['a missing token', {}],
    ['an explicit null token', { conduit_token: null }],
    ['a blank token', { conduit_token: '   ' }],
    ['a non-string token', { conduit_token: 42 }],
  ])('resolves with no conduit token for a 200 prepare with %s', async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(createClient().prepareConversation({ action: 'next' })).resolves.toEqual({});
  });
});

describe('ChatGPTWebClient.streamConversation', () => {
  it('streams events from the plain conversation endpoint with all sentinel headers', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        '"v1"',
        JSON.stringify({
          o: 'add',
          p: '',
          v: {
            conversation_id: 'conv-9',
            message: {
              author: { role: 'assistant' },
              channel: 'final',
              content: { content_type: 'text', parts: [''] },
              id: 'm1',
            },
          },
        }),
        JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: 'Hi' }),
        '[DONE]',
      ]),
    );

    const events = [];
    for await (const event of createClient().streamConversation({}, { requirements }))
      events.push(event);

    expect(events.map((event) => event.type)).toEqual(['conversation.start', 'text.delta', 'done']);

    const { headers, url } = callAt(0);
    expect(url).toBe('https://chatgpt.com/backend-api/conversation');
    expect(headers['Accept']).toBe('text/event-stream');
    expect(headers['OpenAI-Sentinel-Proof-Token']).toBe('gAAAAABproof');
    expect(headers['OpenAI-Sentinel-Turnstile-Token']).toBe('turnstile-token');
    expect(headers['OpenAI-Sentinel-SO-Token']).toBe('so-token');
    expect(headers['X-Conduit-Token']).toBeUndefined();
  });

  it('uses the conduit variant for the /f/ path', async () => {
    fetchMock.mockResolvedValue(sseResponse(['[DONE]']));
    const turnIdentity = {
      observationId: 'abcdefghijklmnop',
      traceId: '11111111-1111-4111-8111-111111111111',
    };

    for await (const _event of createClient().streamConversation(
      {},
      { conduitToken: 'conduit-1', requirements, turnIdentity, useFPath: true },
    ));

    const { headers, url } = callAt(0);
    expect(url).toBe('https://chatgpt.com/backend-api/f/conversation');
    expect(headers['X-Conduit-Token']).toBe('conduit-1');
    expect(headers['X-Oai-Turn-Trace-Id']).toBe(turnIdentity.traceId);
    expect(headers['X-Oai-Is-Client-Observation']).toBe(`v1.s.p.${turnIdentity.observationId}`);
    // Captured Pro turns send the turnstile proof on the conduit SSE request,
    // while the SO token remains exclusive to the plain endpoint.
    expect(headers['OpenAI-Sentinel-Turnstile-Token']).toBe('turnstile-token');
    expect(headers['OpenAI-Sentinel-SO-Token']).toBeUndefined();
  });

  it('classifies a 429 raised before the stream starts', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', { headers: { 'retry-after': '3' }, status: 429 }),
    );

    await expect(
      (async () => {
        for await (const _event of createClient().streamConversation({}, { requirements }));
      })(),
    ).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 3000 });
  });

  it('rejects on caller abort and never emits a done event', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(new TextEncoder().encode('data: {"v":"partial"}\n\n'));
            // …and then nothing: the turn never finishes
          },
        }),
        { headers: { 'content-type': 'text/event-stream' }, status: 200 },
      ),
    );

    const seen: string[] = [];
    setTimeout(() => controller.abort(), 20);
    await expect(
      (async () => {
        for await (const event of createClient().streamConversation(
          {},
          { requirements, signal: controller.signal },
        ))
          seen.push(event.type);
      })(),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(seen).not.toContain('done');
  });

  it('rejects with a timeout when the hard cap expires mid-turn', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(new TextEncoder().encode('data: {"v":"partial"}\n\n'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' }, status: 200 },
      ),
    );

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const event of createClient().streamConversation(
          {},
          { hardCapMs: 20, requirements },
        ))
          seen.push(event.type);
      })(),
    ).rejects.toMatchObject({ kind: 'timeout' });

    expect(seen).not.toContain('done');
  });
});

/**
 * A handed-off turn: the conversation call answers with the resume token, the
 * handoff descriptor and `[DONE]` — and no content at all (verified live
 * 2026-08-15).
 */
const HANDOFF_PAYLOADS = [
  '"v1"',
  JSON.stringify({
    conversation_id: 'conv-h',
    kind: 'topic',
    token: 'resume-jwt',
    type: 'resume_conversation_token',
  }),
  JSON.stringify({
    conversation_id: 'conv-h',
    options: [
      { topic_id: 'conversation-turn-1', type: 'resume_sse_endpoint' },
      { topic_id: 'ws-1', type: 'subscribe_ws_topic' },
    ],
    turn_exchange_id: 'exchange-1',
    type: 'stream_handoff',
  }),
  '[DONE]',
];

const answerPayloads = (text: string) => [
  '"v1"',
  JSON.stringify({
    o: 'add',
    p: '',
    v: {
      conversation_id: 'conv-h',
      message: {
        author: { role: 'assistant' },
        channel: 'final',
        content: { content_type: 'text', parts: [''] },
        id: 'm-answer',
      },
    },
  }),
  JSON.stringify({ o: 'append', p: '/message/content/parts/0', v: text }),
  '[DONE]',
];

describe('ChatGPTWebClient resume', () => {
  it('follows a stream handoff onto /f/conversation/resume', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(HANDOFF_PAYLOADS))
      .mockResolvedValueOnce(sseResponse(answerPayloads('391')));

    const events = [];
    for await (const event of createClient().streamConversation(
      {},
      { conduitToken: 'conduit-1', requirements, useFPath: true },
    ))
      events.push(event);

    // the consumer sees ONE continuous stream, never the handoff bookkeeping
    expect(events.map((event) => event.type)).toEqual(['conversation.start', 'text.delta', 'done']);
    expect(events.find((event) => event.type === 'text.delta')).toMatchObject({ delta: '391' });

    const resume = callAt(1);
    expect(resume.url).toBe('https://chatgpt.com/backend-api/f/conversation/resume');
    expect(resume.init.method).toBe('POST');
    expect(JSON.parse(String(resume.init.body))).toEqual({
      conversation_id: 'conv-h',
      offset: 0,
    });
    expect(resume.headers['X-Conduit-Token']).toBe('resume-jwt');
    expect(resume.headers['X-Oai-Turn-Trace-Id']).toBeTruthy();
    expect(resume.headers['Authorization']).toBe('Bearer access-token');
    expect(resume.headers['Accept']).toBe('text/event-stream');
  });

  it('does not resume when autoResume is off', async () => {
    fetchMock.mockResolvedValue(sseResponse(HANDOFF_PAYLOADS));

    const events = [];
    for await (const event of createClient().streamConversation(
      {},
      { autoResume: false, requirements, useFPath: true },
    ))
      events.push(event);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(['conversation.start', 'done']);
  });

  it('retries a resume leg that fails with a 5xx', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(HANDOFF_PAYLOADS))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(sseResponse(answerPayloads('ok')));

    const events = [];
    for await (const event of createClient().streamConversation(
      {},
      { requirements, useFPath: true },
    ))
      events.push(event);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(events.find((event) => event.type === 'text.delta')).toMatchObject({ delta: 'ok' });
  }, 15_000);

  it('ends the turn cleanly when the resume cannot be established', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(HANDOFF_PAYLOADS))
      .mockResolvedValue(new Response('{}', { status: 404 }));

    const events = [];
    for await (const event of createClient().streamConversation(
      {},
      { requirements, useFPath: true },
    ))
      events.push(event);

    // a 404 is not retried; the turn ends so the caller can poll the document
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // …and says so: a turn that never finished must not look like a clean one
    expect(events.at(-1)).toMatchObject({
      conversationId: 'conv-h',
      endTurn: false,
      recoveryRequired: true,
      type: 'done',
    });
  });

  it('flags recovery when a resume leg dies AFTER emitting part of the answer', async () => {
    fetchMock
      .mockResolvedValueOnce(sseResponse(HANDOFF_PAYLOADS))
      // the resume leg streams a partial answer and then the body breaks
      .mockResolvedValueOnce(brokenSseResponse(answerPayloads('the first half').slice(0, -1)));

    const events = [];
    for await (const event of createClient().streamConversation(
      {},
      { maxResumes: 1, requirements, useFPath: true },
    ))
      events.push(event);

    expect(events.find((event) => event.type === 'text.delta')).toMatchObject({
      delta: 'the first half',
    });
    expect(events.at(-1)).toMatchObject({ recoveryRequired: true, type: 'done' });
  });

  it('flags recovery when the resume budget runs out while still handed off', async () => {
    fetchMock.mockImplementation(async () => sseResponse(HANDOFF_PAYLOADS));

    const events = [];
    for await (const event of createClient().streamConversation(
      {},
      { maxResumes: 1, requirements, useFPath: true },
    ))
      events.push(event);

    expect(events.at(-1)).toMatchObject({ recoveryRequired: true, type: 'done' });
  });

  it('stops after the resume budget instead of chaining forever', async () => {
    // a fresh Response per call: a body can only be read once
    fetchMock.mockImplementation(async () => sseResponse(HANDOFF_PAYLOADS));

    const events = [];
    for await (const event of createClient().streamConversation(
      {},
      { maxResumes: 2, requirements, useFPath: true },
    ))
      events.push(event);

    // the initial leg plus two resumes
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('exposes resumeConversation on its own', async () => {
    fetchMock.mockResolvedValue(sseResponse(answerPayloads('42')));

    const events = [];
    for await (const event of createClient().resumeConversation({
      conversationId: 'conv-h',
      offset: 3,
      resumeToken: 'resume-jwt',
    }))
      events.push(event);

    expect(JSON.parse(String(callAt(0).init.body))).toEqual({
      conversation_id: 'conv-h',
      offset: 3,
    });
    expect(events.find((event) => event.type === 'text.delta')).toMatchObject({ delta: '42' });
  });
});

describe('ChatGPTWebClient assets', () => {
  it('resolves file and attachment download urls', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ download_url: 'https://files.oaiusercontent.com/one' }))
      .mockResolvedValueOnce(jsonResponse({ url: 'https://files.oaiusercontent.com/two' }));

    const client = createClient();
    expect(await client.getFileDownloadUrl('file_1')).toBe('https://files.oaiusercontent.com/one');
    expect(await client.getAttachmentDownloadUrl('conv-1', 'sed_1')).toBe(
      'https://files.oaiusercontent.com/two',
    );

    expect(callAt(0).url).toBe('https://chatgpt.com/backend-api/files/file_1/download');
    expect(callAt(1).url).toBe(
      'https://chatgpt.com/backend-api/conversation/conv-1/attachment/sed_1/download',
    );
  });

  it('resolves a code-interpreter sandbox path into a download url', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        download_url:
          'https://chatgpt.com/backend-api/estuary/content?id=file_1&fn=aihub-test.pdf&cd=attachment',
        metadata: { file_id: 'file_1', file_name: 'aihub-test.pdf' },
        status: 'success',
      }),
    );

    const resolved = await createClient().resolveInterpreterFile({
      conversationId: 'conv-1',
      messageId: 'msg-1',
      // accepted with or without the scheme
      sandboxPath: 'sandbox:/mnt/data/aihub-test.pdf',
    });

    expect(resolved).toEqual({
      downloadUrl:
        'https://chatgpt.com/backend-api/estuary/content?id=file_1&fn=aihub-test.pdf&cd=attachment',
      fileId: 'file_1',
      name: 'aihub-test.pdf',
    });

    const { headers, url } = callAt(0);
    expect(url).toBe(
      'https://chatgpt.com/backend-api/conversation/conv-1/interpreter/download?message_id=msg-1&sandbox_path=%2Fmnt%2Fdata%2Faihub-test.pdf',
    );
    expect(headers['X-OpenAI-Target-Path']).toBe(
      '/backend-api/conversation/conv-1/interpreter/download',
    );
    expect(headers['Referer']).toBe('https://chatgpt.com/c/conv-1');
    expect(headers['Authorization']).toBe('Bearer access-token');
  });

  it.each([
    ['a space', '/mnt/data/my report.pdf', '%2Fmnt%2Fdata%2Fmy%20report.pdf'],
    ['a fragment marker', '/mnt/data/a#b.csv', '%2Fmnt%2Fdata%2Fa%23b.csv'],
    ['unicode', '/mnt/data/报告.docx', '%2Fmnt%2Fdata%2F%E6%8A%A5%E5%91%8A.docx'],
    ['an ampersand', '/mnt/data/a&b.txt', '%2Fmnt%2Fdata%2Fa%26b.txt'],
  ])('escapes %s in the sandbox_path query', async (_label, sandboxPath, encoded) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_1' }),
    );

    await createClient().resolveInterpreterFile({
      conversationId: 'conv-1',
      messageId: 'msg#1',
      sandboxPath,
    });

    expect(callAt(0).url).toBe(
      `https://chatgpt.com/backend-api/conversation/conv-1/interpreter/download?message_id=msg%231&sandbox_path=${encoded}`,
    );
  });

  it('refuses an interpreter download url pointing off-allowlist', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ download_url: 'http://169.254.169.254/' }));

    await expect(
      createClient().resolveInterpreterFile({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        sandboxPath: '/mnt/data/x.pdf',
      }),
    ).rejects.toMatchObject({ kind: 'upstream' });
  });

  describe('host allowlist (defence in depth against SSRF)', () => {
    it.each([
      ['loopback', 'https://127.0.0.1/asset'],
      ['localhost', 'https://localhost/asset'],
      ['link-local metadata', 'http://169.254.169.254/latest/meta-data/'],
      ['a private address', 'https://10.0.0.5/asset'],
      ['plain http on an allowed host', 'http://chatgpt.com/backend-api/estuary/content'],
      ['a spoofed suffix', 'https://chatgpt.com.evil.example/asset'],
      ['a spoofed prefix', 'https://evilchatgpt.com/asset'],
      ['a userinfo trick', 'https://chatgpt.com@evil.example/asset'],
      ['a file url', 'file:///etc/passwd'],
      ['nonsense', 'not a url'],
    ])('refuses to download from %s', async (_label, url) => {
      await expect(createClient().downloadBytes(url)).rejects.toMatchObject({
        kind: 'upstream',
        name: 'ChatGPTWebError',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses an upload url the file-create response points off-allowlist', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ file_id: 'file_1', upload_url: 'https://evil.example/put' }),
      );

      await expect(
        createClient().uploadFile(new Uint8Array([1]), {
          kind: 'image',
          mimeType: 'image/png',
          name: 'a.png',
        }),
      ).rejects.toMatchObject({ kind: 'upstream' });
      // the create call happened; the blob PUT never did
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['getFileDownloadUrl', (client: any) => client.getFileDownloadUrl('file_1')],
      [
        'getAttachmentDownloadUrl',
        (client: any) => client.getAttachmentDownloadUrl('conv-1', 'sed_1'),
      ],
    ])('refuses a download url %s reads off-allowlist', async (_label, call) => {
      fetchMock.mockResolvedValue(jsonResponse({ download_url: 'http://169.254.169.254/' }));

      await expect(call(createClient())).rejects.toMatchObject({ kind: 'upstream' });
    });

    it('never puts the url itself into the error message', async () => {
      const error = await createClient()
        .downloadBytes('https://evil.example/asset?sig=SECRET-SIGNATURE')
        .catch((raised: Error) => raised);

      expect(String(error)).not.toContain('SECRET-SIGNATURE');
      expect(String(error)).not.toContain('evil.example');
    });

    it('rejects a CR/LF-bearing access token before it reaches the transport', async () => {
      const client = new ChatGPTWebClient({
        accessToken: 'token\r\nX-Injected: 1',
        fetch: fetchMock as unknown as typeof fetch,
      });

      await expect(
        client.downloadBytes('https://chatgpt.com/backend-api/estuary/content?id=1'),
      ).rejects.toMatchObject({ kind: 'upstream' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('downloads bytes without leaking the bearer token to blob storage', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' },
        status: 200,
      }),
    );

    const result = await createClient().downloadBytes(
      'https://oaiusercontent.blob.core.windows.net/signed',
    );

    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.mimeType).toBe('image/png');
    expect(callAt(0).headers['Authorization']).toBeUndefined();
    expect(callAt(0).headers.Origin).toBeUndefined();
    expect(callAt(0).headers['Sec-Fetch-Dest']).toBe('image');
    expect(callAt(0).headers['Sec-Fetch-Mode']).toBe('no-cors');
    expect(callAt(0).headers['Sec-Fetch-Site']).toBe('cross-site');
    expect(
      Object.keys(callAt(0).headers).filter((key) =>
        /^(?:authorization|oai-|x-openai-|x-aihub-)/i.test(key),
      ),
    ).toEqual([]);
  });

  it('authenticates asset downloads served by chatgpt.com itself', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' },
        status: 200,
      }),
    );

    // generated images resolve to /backend-api/estuary/content, which is not signed
    await createClient().downloadBytes('https://chatgpt.com/backend-api/estuary/content?id=file_1');

    expect(callAt(0).headers['Authorization']).toBe('Bearer access-token');
    expect(callAt(0).headers.Origin).toBeUndefined();
    expect(callAt(0).headers['Sec-Fetch-Dest']).toBe('image');
    expect(callAt(0).headers['Sec-Fetch-Site']).toBe('same-origin');
  });

  it('filters tasks by conversation client side', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        tasks: [
          { conversation_id: 'conv-1', task_id: 'a' },
          { original_conversation_id: 'conv-1', task_id: 'b' },
          { conversation_id: 'other', task_id: 'c' },
        ],
      }),
    );

    const tasks = await createClient().listTasks('conv-1');

    expect(tasks.map((task: any) => task.task_id)).toEqual(['a', 'b']);
    expect(callAt(0).url).toBe('https://chatgpt.com/backend-api/tasks');
  });
});

describe('ChatGPTWebClient.waitForFileReady', () => {
  it('returns once the upstream reports a token size', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ retrieval_index_status: 'in_progress' }))
      .mockResolvedValueOnce(
        jsonResponse({ file_token_size: 512, retrieval_index_status: 'success' }),
      );

    const result = await createClient().waitForFileReady('file_1', { intervalMs: 1 });

    expect(result).toEqual({ fileTokenSize: 512, status: 'success' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops on an indexing failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ retrieval_index_status: 'failed' }));

    await expect(
      createClient().waitForFileReady('file_1', { intervalMs: 1 }),
    ).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('keeps polling while only ONE of the two readiness signals is present', async () => {
    fetchMock
      // indexed, but no token size yet — attaching now yields an empty retrieval
      .mockResolvedValueOnce(jsonResponse({ retrieval_index_status: 'success' }))
      // token size, but still indexing
      .mockResolvedValueOnce(
        jsonResponse({ file_token_size: 10, retrieval_index_status: 'in_progress' }),
      )
      .mockResolvedValue(jsonResponse({ file_token_size: 10, retrieval_index_status: 'success' }));

    const result = await createClient().waitForFileReady('file_1', { intervalMs: 1 });

    expect(result).toEqual({ fileTokenSize: 10, status: 'success' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws a typed timeout instead of silently returning an unindexed file', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ retrieval_index_status: 'in_progress' }),
    );

    await expect(
      createClient().waitForFileReady('file_1', { intervalMs: 1, timeoutMs: 30 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('aborts during the interval sleep with the caller reason', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      // abort while the poller is between two reads
      queueMicrotask(() => controller.abort());
      return jsonResponse({ retrieval_index_status: 'in_progress' });
    });

    await expect(
      createClient().waitForFileReady('file_1', {
        intervalMs: 5000,
        signal: controller.signal,
        timeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ChatGPTWebClient.downloadBytes bounds', () => {
  const chunkedResponse = (chunkCount: number, chunkSize: number, headers: HeadersInit = {}) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < chunkCount; i += 1) controller.enqueue(new Uint8Array(chunkSize));
          controller.close();
        },
      }),
      { headers, status: 200 },
    );

  it('rejects an oversized declared content-length before reading the body', async () => {
    fetchMock.mockResolvedValue(
      chunkedResponse(1, 4, { 'content-length': String(64 * 1024 * 1024) }),
    );

    await expect(
      createClient().downloadBytes('https://oaiusercontent.blob.core.windows.net/huge'),
    ).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('rejects an oversized chunked body that declares nothing', async () => {
    fetchMock.mockResolvedValue(chunkedResponse(10, 1024));

    await expect(
      createClient().downloadBytes('https://oaiusercontent.blob.core.windows.net/huge', {
        maxBytes: 4096,
      }),
    ).rejects.toMatchObject({ kind: 'upstream' });
  });

  it('accepts a body under the limit', async () => {
    fetchMock.mockResolvedValue(chunkedResponse(2, 8));

    const result = await createClient().downloadBytes(
      'https://oaiusercontent.blob.core.windows.net/small',
      {
        maxBytes: 4096,
      },
    );

    expect(result.bytes.length).toBe(16);
  });
});

describe('ChatGPTWebClient.listModels', () => {
  it('maps slugs and drops entries without one', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        models: [
          { max_tokens: 128_000, slug: 'auto', title: 'Auto' },
          { description: 'x' },
          { slug: 'gpt-5-5' },
        ],
      }),
    );

    const models = await createClient().listModels();

    expect(models.map((model) => model.slug)).toEqual(['auto', 'gpt-5-5']);
    expect(models[0]).toMatchObject({ maxTokens: 128_000, title: 'Auto' });
    expect(callAt(0).url).toBe(
      'https://chatgpt.com/backend-api/models?history_and_training_disabled=false',
    );
    expect(callAt(0).headers['X-OpenAI-Target-Path']).toBe('/backend-api/models');
  });
});

describe('ChatGPTWebClient.getConversationInit', () => {
  it('extracts the image quota', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        default_model_slug: 'auto',
        limits_progress: [
          { feature_name: 'image_gen', remaining: 3, reset_after: '2026-08-15T00:00:00Z' },
        ],
      }),
    );

    expect(await createClient().getConversationInit()).toMatchObject({
      defaultModelSlug: 'auto',
      imageQuotaRemaining: 3,
      imageQuotaResetAfter: '2026-08-15T00:00:00Z',
    });
  });
});
