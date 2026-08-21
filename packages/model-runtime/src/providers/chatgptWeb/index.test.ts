import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntimeErrorType } from '../../types/error';
import { debugStream } from '../../utils/debugStream';
import {
  pickGenerateObjectEffortParams,
  projectServiceModelEffort,
} from '../../utils/serviceModelEffort';
import type { ConversationEvent } from './client';
import { bytesToBase64, ChatGPTWebError } from './client';
import { describeRequestBody, LobeChatGPTWebAI, undeliveredSuffix } from './index';
import { clearUploadCache } from './uploadCache';

vi.mock('../../utils/debugStream', () => ({ debugStream: vi.fn(async () => {}) }));

const streamingResponse = vi.hoisted(() => ({
  impl: (stream: ReadableStream, options?: { headers?: Record<string, string> }) =>
    new Response(stream, {
      headers: {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
        ...options?.headers,
      },
    }),
}));

vi.mock('../../utils/response', () => ({
  StreamingResponse: (stream: ReadableStream, options?: { headers?: Record<string, string> }) =>
    streamingResponse.impl(stream, options),
}));

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);
const PNG_BASE64 = bytesToBase64(PNG_BYTES);

const defaultEvents: ConversationEvent[] = [
  { conversationId: 'conv-1', type: 'conversation.start' },
  { delta: 'pong', text: 'pong', type: 'text.delta' },
  { conversationId: 'conv-1', endTurn: true, type: 'done' },
];

const createFakeClient = (overrides: Record<string, any> = {}) => {
  const streamConversation = vi.fn(async function* (_body: object, _options: object) {
    for (const event of defaultEvents) yield event;
  });

  const getChatRequirements =
    overrides.getChatRequirements ??
    vi.fn(async () => ({
      proofToken: 'p',
      soToken: 's',
      token: 't',
      turnstileToken: 'ts',
    }));

  return {
    accountId: 'acc-1',
    acquireSentinelBundle:
      overrides.acquireSentinelBundle ??
      vi.fn(async (opts?: { signal?: AbortSignal }) => ({
        expiresAtMs: Date.now() + 540_000,
        id: 'bundle-test',
        requirements: await getChatRequirements(opts ?? {}),
      })),
    downloadBytes: vi.fn(async () => ({ bytes: PNG_BYTES, mimeType: 'image/png' })),
    getAttachmentDownloadUrl: vi.fn(async () => 'https://blob/attachment'),
    getChatRequirements,
    getConversation: vi.fn(async () => ({})),
    getFileDownloadUrl: vi.fn(async () => 'https://blob/file'),
    hideConversation: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    prepareConversation: vi.fn(async () => ({ conduitToken: 'conduit' })),
    replenishSentinelBundle: vi.fn(),
    resolveInterpreterFile: vi.fn(async () => ({
      downloadUrl: '',
      fileId: undefined,
      name: undefined,
    })),
    streamConversation,
    uploadFile: vi.fn(async (bytes: Uint8Array, meta: any) => ({
      fileId: 'file-1',
      height: meta.height,
      kind: meta.kind,
      mimeType: meta.mimeType,
      name: meta.name,
      size: bytes.length,
      width: meta.width,
    })),
    waitForFileReady: vi.fn(async () => ({ fileTokenSize: 42, status: 'success' })),
    ...overrides,
  };
};

const createRuntime = (client: any) =>
  new LobeChatGPTWebAI({ apiKey: 'token', client: client as any });

const readSSE = async (response: Response) => await response.text();

const collectStream = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream as any)
    text += decoder.decode(chunk as Uint8Array, { stream: true });
  return text;
};

/** The image download path is a bounded fetch, not `imageUrlToBase64`. */
const stubImageFetch = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(PNG_BYTES, {
          headers: { 'content-length': String(PNG_BYTES.length), 'content-type': 'image/png' },
          status: 200,
        }),
    ),
  );

const bodyOf = (client: any, call = 0) => client.streamConversation.mock.calls[call][0];
const optionsOf = (client: any, call = 0) => client.streamConversation.mock.calls[call][1];

const nowSec = () => Date.now() / 1000;

/** The id the request body generated for the turn's last user message. */
const userMessageIdOf = (body: any): string =>
  [...body.messages].reverse().find((message: any) => message.author.role === 'user').id;

/**
 * A conversation document whose assistant answer descends from the user message
 * of `body` — the only shape the runtime is allowed to accept as this turn's
 * answer.
 */
const documentFor = (body: any, message: { parts: string[]; status: string }) => ({
  mapping: {
    [userMessageIdOf(body)]: { message: { author: { role: 'user' } } },
    answer: {
      message: {
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: message.parts },
        create_time: nowSec(),
        end_turn: true,
        metadata: {},
        status: message.status,
      },
      parent: userMessageIdOf(body),
    },
  },
});

const defaultStreamingResponse = streamingResponse.impl;

beforeEach(() => {
  streamingResponse.impl = defaultStreamingResponse;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  clearUploadCache();
});

describe('LobeChatGPTWebAI', () => {
  it('requires an access token', () => {
    expect(() => new LobeChatGPTWebAI({})).toThrowError();
  });

  describe('chat payload mapping', () => {
    it('replays the history as user/assistant turns and streams the answer', async () => {
      const client = createFakeClient();
      const response = await createRuntime(client).chat({
        messages: [
          { content: 'be terse', role: 'system' },
          { content: 'hi', role: 'user' },
          { content: 'hello', role: 'assistant' },
          { content: 'Reply with exactly: pong', role: 'user' },
        ],
        model: 'auto',
        temperature: 1,
      });

      const body = bodyOf(client);
      expect(body.model).toBe('auto');
      // NO `system` author: a browser session never sends one, so the system
      // instruction is folded into the user turn it precedes.
      expect(body.messages.map((message: any) => message.author.role)).toEqual([
        'user',
        'assistant',
        'user',
      ]);
      expect(body.messages[0].content.parts).toEqual(['be terse\n\nhi']);
      // every turn goes through the conduit path — see the `/f/` default below
      expect(optionsOf(client)).toMatchObject({ conduitToken: 'conduit', useFPath: true });
      // the assistant turn is registered so the upstream echo can be dropped
      expect(optionsOf(client).echoHistory).toEqual(['hello']);

      const sse = await readSSE(response);
      expect(sse).toContain('event: text');
      expect(sse).toContain('data: "pong"');
      expect(sse).toContain('event: stop');
    });

    it('sends a trailing system instruction as its own user turn', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [
          { content: 'ask me', role: 'user' },
          { content: 'sure', role: 'assistant' },
          { content: 'wrap it up now', role: 'system' },
        ],
        model: 'gpt-5-6',
        temperature: 1,
      });

      const body = bodyOf(client);
      expect(body.messages.map((message: any) => message.author.role)).toEqual([
        'user',
        'assistant',
        'user',
      ]);
      expect(body.messages.at(-1).content.parts).toEqual(['wrap it up now']);
      // the prepare `partial_query` follows the last user turn
      const prepareBody = (client.prepareConversation.mock.calls[0] as any[])[0];
      expect(prepareBody.partial_query.content.parts).toEqual(['wrap it up now']);
    });

    /**
     * Instructions are folded into the user turn they IMMEDIATELY precede. When
     * the next turn is an assistant one, carrying them forward would move them
     * behind an answer they were meant to govern, so they become their own user
     * turn in place. `AgentDocumentMessageInjector` puts a system message after
     * the first user turn, so this is reachable in a real conversation.
     */
    describe('instruction ordering', () => {
      const rolesAndParts = async (messages: any[]) => {
        const client = createFakeClient();
        await createRuntime(client).chat({ messages, model: 'gpt-5-6', temperature: 1 });
        return bodyOf(client).messages.map((message: any) => [
          message.author.role,
          message.content.parts.join(''),
        ]);
      };

      it('keeps an instruction between a user and an assistant turn in place', async () => {
        expect(
          await rolesAndParts([
            { content: 'U1', role: 'user' },
            { content: 'D', role: 'system' },
            { content: 'A1', role: 'assistant' },
            { content: 'U2', role: 'user' },
          ]),
        ).toEqual([
          ['user', 'U1'],
          ['user', 'D'],
          ['assistant', 'A1'],
          ['user', 'U2'],
        ]);
      });

      it('keeps a leading instruction before an assistant turn', async () => {
        expect(
          await rolesAndParts([
            { content: 'S', role: 'system' },
            { content: 'A', role: 'assistant' },
          ]),
        ).toEqual([
          ['user', 'S'],
          ['assistant', 'A'],
        ]);
      });

      it('keeps an instruction between two assistant turns in place', async () => {
        expect(
          await rolesAndParts([
            { content: 'A1', role: 'assistant' },
            { content: 'S', role: 'system' },
            { content: 'A2', role: 'assistant' },
          ]),
        ).toEqual([
          ['assistant', 'A1'],
          ['user', 'S'],
          ['assistant', 'A2'],
        ]);
      });

      // the empty user turn is dropped before it can absorb anything, so the
      // instruction must not ride along to the assistant turn behind it
      it('keeps an instruction in place when the user turn after it is empty', async () => {
        expect(
          await rolesAndParts([
            { content: 'S', role: 'system' },
            { content: '', role: 'user' },
            { content: 'A', role: 'assistant' },
          ]),
        ).toEqual([
          ['user', 'S'],
          ['assistant', 'A'],
        ]);
      });

      it('merges consecutive instructions into the user turn that follows', async () => {
        expect(
          await rolesAndParts([
            { content: 'S1', role: 'system' },
            { content: 'S2', role: 'system' },
            { content: 'U', role: 'user' },
          ]),
        ).toEqual([['user', 'S1\n\nS2\n\nU']]);
      });

      it('sends an instruction-only payload as a single user turn', async () => {
        expect(
          await rolesAndParts([
            { content: 'S1', role: 'system' },
            { content: 'S2', role: 'system' },
          ]),
        ).toEqual([['user', 'S1\n\nS2']]);
      });
    });

    it('keeps a system message that carries attachments as a user turn', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [
          {
            content: [
              { text: 'context', type: 'text' },
              { image_url: { url: `data:image/png;base64,${PNG_BASE64}` }, type: 'image_url' },
            ] as any,
            role: 'system',
          },
          { content: 'go', role: 'user' },
        ],
        model: 'gpt-5-6',
        temperature: 1,
      });

      const body = bodyOf(client);
      expect(body.messages.map((message: any) => message.author.role)).toEqual(['user', 'user']);
      expect(body.messages[0].metadata.attachments).toHaveLength(1);
    });

    // upstream only accepts standard | extended | max (live 2026-08-15: low /
    // medium / high are 422 "Invalid conversation body")
    it.each([
      ['low', 'standard'],
      ['medium', 'standard'],
      ['high', 'extended'],
      ['xhigh', 'extended'],
      ['max', 'max'],
      ['none', undefined],
      ['minimal', undefined],
    ])('maps reasoning_effort %s → thinking_effort %s', async (effort, expected) => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-5-6-thinking',
        reasoning_effort: effort as any,
        temperature: 1,
      });

      expect(bodyOf(client).thinking_effort).toBe(expected);
      // the conduit path is the default; an effort additionally MAKES it
      // mandatory (the plain endpoint rejects `thinking_effort` outright)
      expect(optionsOf(client).useFPath).toBe(true);
    });

    it('omits thinking_effort for a -thinking model without an effort', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-5-6-thinking',
        temperature: 1,
      });

      expect(bodyOf(client).thinking_effort).toBeUndefined();
    });

    // Verified against a captured real Chrome session (2026-08-19): picking Pro
    // with no explicit user-chosen effort still sends `thinking_effort: "standard"`
    // — the same default other reasoning-capable tiers get. Picking Pro on the
    // real client IS the effort selection, so AIHub must send the field too.
    it('defaults thinking_effort to standard for a -pro model without an effort', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-5-6-pro',
        temperature: 1,
      });

      expect(bodyOf(client).thinking_effort).toBe('standard');
      expect(client.prepareConversation).toHaveBeenCalledTimes(2);
      expect(
        client.prepareConversation.mock.calls.map(([body]: any[]) => body.client_prepare_state),
      ).toEqual(['success', 'sent']);
      const [, firstOptions] = client.prepareConversation.mock.calls[0] as any[];
      const [, secondOptions] = client.prepareConversation.mock.calls[1] as any[];
      expect(secondOptions.turnIdentity).toBe(firstOptions.turnIdentity);
      expect(optionsOf(client).turnIdentity).toBe(firstOptions.turnIdentity);
      // Chrome starts the Pro send while both prepares are still pending, so a
      // late conduit token is never an input to this request.
      expect(optionsOf(client).conduitToken).toBeUndefined();
      // an effort makes the turn mandatory-conduit — a -pro turn must never be
      // allowed to fall back to the endpoint that cannot serve it.
      expect(optionsOf(client).useFPath).toBe(true);
    });

    it('starts a -pro conversation before either prepare response settles', async () => {
      const settlePrepares: Array<(value: { conduitToken?: string }) => void> = [];
      let settled = 0;
      const prepareConversation = vi.fn(
        () =>
          new Promise<{ conduitToken?: string }>((resolve) => {
            settlePrepares.push((value) => {
              settled += 1;
              resolve(value);
            });
          }),
      );
      const client = createFakeClient({ prepareConversation });

      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-5-6-pro',
        temperature: 1,
      });

      expect(prepareConversation).toHaveBeenCalledTimes(2);
      expect(settled).toBe(0);
      expect(client.streamConversation).toHaveBeenCalledTimes(1);
      expect(Math.max(...prepareConversation.mock.invocationCallOrder)).toBeLessThan(
        client.streamConversation.mock.invocationCallOrder[0]!,
      );
      expect(optionsOf(client)).toMatchObject({ conduitToken: undefined, useFPath: true });

      for (const settle of settlePrepares) settle({ conduitToken: 'too-late' });
      await Promise.resolve();
    });

    it('does not override an explicit lower effort on a -pro model', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-5-6-pro',
        reasoning_effort: 'low' as any,
        temperature: 1,
      });

      expect(bodyOf(client).thinking_effort).toBe('standard');
    });

    it('defaults a family id without effort to Medium (thinking slug + standard)', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-5-6',
        temperature: 1,
      });

      expect(bodyOf(client).model).toBe('gpt-5-6-thinking');
      expect(bodyOf(client).thinking_effort).toBe('standard');
    });

    it('ignores leftover generic reasoning_effort on a bare family id', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-5-6',
        reasoning_effort: 'high' as any,
        temperature: 1,
      });

      expect(bodyOf(client).model).toBe('gpt-5-6-thinking');
      expect(bodyOf(client).thinking_effort).toBe('standard');
    });

    it.each([
      ['instant', 'gpt-5-6-instant', undefined],
      ['medium', 'gpt-5-6-thinking', 'standard'],
      ['high', 'gpt-5-6-thinking', 'extended'],
      ['xhigh', 'gpt-5-6-thinking', 'max'],
    ] as const)(
      'family gpt-5-6 + %s → model %s / thinking_effort %s',
      async (effort, model, thinkingEffort) => {
        const client = createFakeClient();
        await createRuntime(client).chat({
          chatgptWebReasoningEffort: effort,
          messages: [{ content: 'hi', role: 'user' }],
          model: 'gpt-5-6',
          temperature: 1,
        });

        expect(bodyOf(client).model).toBe(model);
        expect(bodyOf(client).thinking_effort).toBe(thinkingEffort);
      },
    );

    it.each(['instant', 'pro'] as const)(
      'system-agent projected %s reaches LobeChatGPTWebAI on a family id',
      async (level) => {
        const picked = pickGenerateObjectEffortParams(
          projectServiceModelEffort({
            extendParams: ['chatgptWebReasoningEffort'],
            model: 'gpt-5-6',
            reasoningEffort: level,
          }),
        );
        expect(picked).toEqual({ chatgptWebReasoningEffort: level });

        const client = createFakeClient();
        await createRuntime(client).chat({
          ...picked,
          messages: [{ content: 'hi', role: 'user' }],
          model: 'gpt-5-6',
          temperature: 1,
        });

        expect(bodyOf(client).model).toBe(level === 'pro' ? 'gpt-5-6-pro' : 'gpt-5-6-instant');
        expect(bodyOf(client).thinking_effort).toBe(level === 'pro' ? 'standard' : undefined);
      },
    );

    it('family + pro takes the existing Pro path (dual prepare, standard effort)', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        chatgptWebReasoningEffort: 'pro',
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-5-6',
        temperature: 1,
      });

      expect(bodyOf(client).model).toBe('gpt-5-6-pro');
      expect(bodyOf(client).thinking_effort).toBe('standard');
      expect(client.prepareConversation).toHaveBeenCalledTimes(2);
      expect(
        client.prepareConversation.mock.calls.map(([body]: any[]) => body.client_prepare_state),
      ).toEqual(['success', 'sent']);
      expect(client.prepareConversation.mock.calls.map(([body]: any[]) => body.model)).toEqual([
        'gpt-5-6-pro',
        'gpt-5-6-pro',
      ]);
      expect(optionsOf(client).conduitToken).toBeUndefined();
      expect(optionsOf(client).useFPath).toBe(true);
    });

    it('omits thinking_effort for o3', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'o3',
        reasoning_effort: 'high' as any,
        temperature: 1,
      });

      expect(bodyOf(client).model).toBe('o3');
      expect(bodyOf(client).thinking_effort).toBeUndefined();
    });

    it('sends every plain turn through the /f/ conduit path', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [{ content: 'Reply with exactly: pong', role: 'user' }],
        model: 'auto',
        temperature: 1,
      });

      expect(client.prepareConversation).toHaveBeenCalledTimes(1);
      const prepareBody = (client.prepareConversation.mock.calls[0] as any[])[0];
      expect(prepareBody.system_hints).toEqual([]);
      expect(prepareBody.attachment_mime_types).toBeUndefined();
      expect(prepareBody.thinking_effort).toBeUndefined();
      expect(prepareBody).not.toHaveProperty('model_response_contracts');

      // the live-verified plain `/f/conversation` body (scratchpad file-probe)
      const body = bodyOf(client);
      expect(body).toMatchObject({
        action: 'next',
        client_prepare_state: 'sent',
        enable_message_followups: true,
        force_parallel_switch: 'auto',
        model_response_contracts: [
          {
            id: 'photo_upload_action.v1',
            protocol_version: 1,
            presets: ['cap:image', 'cap:file', 'placement:end'],
          },
        ],
        paragen_cot_summary_display_override: 'allow',
        parent_message_id: 'client-created-root',
        supported_encodings: ['v1'],
        supports_buffering: true,
        system_hints: [],
      });
      expect(body.client_contextual_info).toMatchObject({ app_name: 'chatgpt.com' });
      expect(body.force_use_search).toBeUndefined();
      // the plain body's opt-out is NOT sent: it makes the conversation
      // unreadable afterwards (no files, no citations, no recovery)
      expect(body.history_and_training_disabled).toBeUndefined();
      expect(optionsOf(client)).toMatchObject({ conduitToken: 'conduit', useFPath: true });
    });

    it('falls back to the plain path once when the conduit prepare fails', async () => {
      const client = createFakeClient({
        prepareConversation: vi.fn(async () => {
          throw new ChatGPTWebError('upstream', 'prepare exploded', { status: 500 });
        }),
      });

      const sse = await readSSE(
        await createRuntime(client).chat({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'auto',
          temperature: 1,
        }),
      );

      expect(client.prepareConversation).toHaveBeenCalledTimes(1);
      expect(optionsOf(client).useFPath).toBeFalsy();
      expect(optionsOf(client).conduitToken).toBeUndefined();
      expect(bodyOf(client).history_and_training_disabled).toBe(true);
      expect(sse).toContain('event: text');
    });

    // A Pro prepare is not a gate: Chrome sends the conversation while both
    // prepare requests are still pending. A late prepare failure is observed,
    // while the actual conversation request remains the source of truth.
    it('does not block a -pro send when a non-gating prepare later fails', async () => {
      const client = createFakeClient({
        prepareConversation: vi.fn(async () => {
          throw new ChatGPTWebError('upstream', 'chat-requirements rejected', { status: 500 });
        }),
      });

      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-5-6-pro',
        temperature: 1,
      });

      expect(client.prepareConversation).toHaveBeenCalledTimes(2);
      expect(client.streamConversation).toHaveBeenCalledTimes(1);
      expect(optionsOf(client)).toMatchObject({ conduitToken: undefined, useFPath: true });
    });

    // Verified against a captured real Chrome session (2026-08-19): the browser
    // gets this exact response for a Pro turn and just proceeds — no
    // `X-Conduit-Token` header, no fallback. `prepareConversation` (see
    // `client.test.ts`) returns `{}` rather than throwing for this case, so the
    // conduit path is used normally end to end.
    it('proceeds via the conduit path when prepare returns no conduit token', async () => {
      const client = createFakeClient({
        prepareConversation: vi.fn(async () => ({})),
      });

      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'gpt-5-6-pro',
        temperature: 1,
      });

      expect(optionsOf(client).useFPath).toBe(true);
      expect(optionsOf(client).conduitToken).toBeUndefined();
      expect(client.prepareConversation).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['a network hiccup', new ChatGPTWebError('network', 'econnreset')],
      ['a timeout', new ChatGPTWebError('timeout', 'prepare aborted')],
      ['a missing endpoint', new ChatGPTWebError('not_found', 'no such path', { status: 404 })],
    ])('falls back to the plain path on %s', async (_label, raised) => {
      const client = createFakeClient({
        prepareConversation: vi.fn(async () => {
          throw raised;
        }),
      });

      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'auto',
        temperature: 1,
      });

      expect(optionsOf(client).useFPath).toBeFalsy();
    });

    it.each([
      ['an auth failure', new ChatGPTWebError('auth', 'token expired', { status: 401 })],
      ['a rate limit', new ChatGPTWebError('rate_limit', 'slow down', { status: 429 })],
      // the plain path is challenged by the very same bot protection
      ['a Cloudflare challenge', new ChatGPTWebError('cloudflare', 'blocked', { status: 403 })],
      // the plain path refuses the model for this account too
      ['a model cap', new ChatGPTWebError('model_cap', 'cap reached', { status: 403 })],
      ['a permission failure', new ChatGPTWebError('permission', 'forbidden', { status: 403 })],
      ['a missing transport', new ChatGPTWebError('transport_unavailable', 'no curl binary')],
      // an untyped failure is a bug of ours, not something the plain path fixes
      ['an unclassified error', new TypeError('cannot read properties of undefined')],
    ])('does not fall back on %s', async (_label, raised) => {
      const client = createFakeClient({
        prepareConversation: vi.fn(async () => {
          throw raised;
        }),
      });

      await expect(
        createRuntime(client).chat({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'auto',
          temperature: 1,
        }),
      ).rejects.toBeDefined();
      expect(client.streamConversation).not.toHaveBeenCalled();
    });

    it('never falls back for a turn the plain body cannot express', async () => {
      const client = createFakeClient({
        prepareConversation: vi.fn(async () => {
          throw new ChatGPTWebError('upstream', 'prepare exploded', { status: 500 });
        }),
      });

      await expect(
        createRuntime(client).chat({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'gpt-5-6-thinking',
          reasoning_effort: 'high' as any,
          temperature: 1,
        }),
      ).rejects.toBeDefined();
      expect(client.streamConversation).not.toHaveBeenCalled();
    });

    it('uses the /f/ conduit path with search switches when search is on', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        enabledSearch: true,
        messages: [{ content: 'latest node?', role: 'user' }],
        model: 'auto',
        temperature: 1,
      });

      expect(client.prepareConversation).toHaveBeenCalledTimes(1);
      const prepareBody = (client.prepareConversation.mock.calls[0] as any[])[0];
      expect(prepareBody.system_hints).toEqual(['search']);
      expect(prepareBody.partial_query.content.parts).toEqual(['latest node?']);

      const body = bodyOf(client);
      expect(body.force_use_search).toBe(true);
      expect(body.messages.at(-1).metadata.system_hints).toEqual(['search']);
      expect(optionsOf(client)).toMatchObject({ conduitToken: 'conduit', useFPath: true });
    });

    it('acquires a sentinel bundle by context key and replenishes after send starts', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'auto',
        temperature: 1,
      });

      expect(client.acquireSentinelBundle).toHaveBeenCalledTimes(1);
      expect(client.acquireSentinelBundle.mock.calls[0][0]).toEqual(
        expect.objectContaining({ contextKey: 'chatgptweb:unscoped' }),
      );
      expect(client.replenishSentinelBundle).toHaveBeenCalledTimes(1);
      expect(client.replenishSentinelBundle.mock.calls[0][0]).toEqual(
        expect.objectContaining({ contextKey: 'chatgptweb:unscoped' }),
      );
    });

    it('forwards a Browser Session Context key into acquire and replenish', async () => {
      const client = createFakeClient();
      await new LobeChatGPTWebAI({
        apiKey: 'token',
        browserSessionContextKey: 'c1-context-id',
        client: client as any,
      }).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'auto',
        temperature: 1,
      });

      expect(client.acquireSentinelBundle.mock.calls[0][0]).toEqual(
        expect.objectContaining({ contextKey: 'c1-context-id' }),
      );
      expect(client.replenishSentinelBundle.mock.calls[0][0]).toEqual(
        expect.objectContaining({ contextKey: 'c1-context-id' }),
      );
    });

    it('keys the fallback-profile Sentinel pool by account id, not device id', async () => {
      const clientA = createFakeClient();
      const clientB = createFakeClient();

      await new LobeChatGPTWebAI({
        apiKey: 'token',
        browserSessionAccountId: 'platform:chatgptweb',
        client: clientA as any,
      }).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'auto',
        temperature: 1,
      });
      await new LobeChatGPTWebAI({
        apiKey: 'token',
        browserSessionAccountId: 'user:alice:_:chatgptweb',
        client: clientB as any,
      }).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'auto',
        temperature: 1,
      });

      expect(clientA.acquireSentinelBundle.mock.calls[0][0]).toEqual(
        expect.objectContaining({ contextKey: 'platform:chatgptweb:fallback-profile' }),
      );
      expect(clientB.acquireSentinelBundle.mock.calls[0][0]).toEqual(
        expect.objectContaining({ contextKey: 'user:alice:_:chatgptweb:fallback-profile' }),
      );
    });

    it('chat() calls sessionContext.release in finally', async () => {
      const client = createFakeClient();
      const release = vi.fn();
      const response = await new LobeChatGPTWebAI({
        apiKey: 'token',
        client: client as any,
        sessionContext: {
          contextId: 'ctx-release',
          cookieJarKey: 'ctx:jar-digest',
          getBootstrap: () => undefined,
          logicalPageId: '11111111-1111-4111-8111-111111111111',
          release,
          setBootstrap: () => {},
        },
      }).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'auto',
        temperature: 1,
      });

      expect(release).not.toHaveBeenCalled();
      await readSSE(response);
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('chat() releases the session lease exactly once after the body is cancelled', async () => {
      const client = createFakeClient();
      const release = vi.fn();
      const response = await new LobeChatGPTWebAI({
        apiKey: 'token',
        client: client as any,
        sessionContext: {
          contextId: 'ctx-release-cancel',
          cookieJarKey: 'ctx:jar-digest',
          getBootstrap: () => undefined,
          logicalPageId: '11111111-1111-4111-8111-111111111111',
          release,
          setBootstrap: () => {},
        },
      }).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'auto',
        temperature: 1,
      });

      expect(release).not.toHaveBeenCalled();
      await response.body?.cancel();
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    });

    it('releases the session lease once if StreamingResponse construction throws', async () => {
      const release = vi.fn();
      streamingResponse.impl = () => {
        throw new TypeError('invalid response headers');
      };

      await expect(
        new LobeChatGPTWebAI({
          apiKey: 'token',
          client: createFakeClient() as any,
          sessionContext: {
            contextId: 'ctx-release-wrap',
            cookieJarKey: 'ctx:jar-digest',
            getBootstrap: () => undefined,
            logicalPageId: '11111111-1111-4111-8111-111111111111',
            release,
            setBootstrap: () => {},
          },
        }).chat({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'auto',
          temperature: 1,
        }),
      ).rejects.toBeDefined();

      expect(release).toHaveBeenCalledTimes(1);
    });

    it('uses sessionContext.contextId as the Sentinel pool key', async () => {
      const client = createFakeClient();
      await new LobeChatGPTWebAI({
        apiKey: 'token',
        client: client as any,
        sessionContext: {
          contextId: 'ctx-account-scoped',
          cookieJarKey: 'ctx:jar-digest',
          getBootstrap: () => undefined,
          logicalPageId: '11111111-1111-4111-8111-111111111111',
          setBootstrap: () => {},
        },
      }).chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'auto',
        temperature: 1,
      });

      expect(client.acquireSentinelBundle.mock.calls[0][0]).toEqual(
        expect.objectContaining({ contextKey: 'ctx-account-scoped' }),
      );
    });

    it('surfaces a Cloudflare challenge from the requirements handshake', async () => {
      // the protocol core already retries the handshake internally; the runtime
      // must not add a second retry layer, only a readable error
      const getChatRequirements = vi
        .fn()
        .mockRejectedValue(new ChatGPTWebError('cloudflare', 'blocked', { status: 403 }));
      const client = createFakeClient({ getChatRequirements });

      await expect(
        createRuntime(client).chat({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'auto',
          temperature: 1,
        }),
      ).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.ProviderBizError,
        message: expect.stringContaining('challenging this server'),
      });
      expect(getChatRequirements).toHaveBeenCalledTimes(1);
    });
  });

  describe('attachments', () => {
    it('uploads image parts once and reuses the cached upload', async () => {
      stubImageFetch();
      const client = createFakeClient();
      const runtime = createRuntime(client);

      const payload = {
        messages: [
          {
            content: [
              { text: 'what is this', type: 'text' as const },
              { image_url: { url: 'https://cdn.example/a.png' }, type: 'image_url' as const },
            ],
            role: 'user' as const,
          },
        ],
        model: 'auto',
        temperature: 1,
      };

      await runtime.chat(payload);
      await runtime.chat(payload);

      expect(client.uploadFile).toHaveBeenCalledTimes(1);
      expect(client.uploadFile.mock.calls[0][1]).toMatchObject({
        height: 3,
        kind: 'image',
        mimeType: 'image/png',
        width: 2,
      });

      const body = bodyOf(client);
      expect(optionsOf(client).useFPath).toBe(true);
      const message = body.messages.at(-1);
      expect(message.content.content_type).toBe('multimodal_text');
      expect(message.content.parts[0]).toMatchObject({
        asset_pointer: 'file-service://file-1',
        content_type: 'image_asset_pointer',
      });
      expect(message.metadata.attachments[0]).toMatchObject({
        id: 'file-1',
        mime_type: 'image/png',
      });
    });

    it('never shares the upload cache between credentials without an account id', async () => {
      stubImageFetch();

      const payload = {
        messages: [
          {
            content: [
              { image_url: { url: 'https://cdn.example/a.png' }, type: 'image_url' as const },
            ],
            role: 'user' as const,
          },
        ],
        model: 'auto',
        temperature: 1,
      };

      // same bytes, no account id, two different access tokens
      const first = createFakeClient({ accountId: undefined });
      const second = createFakeClient({ accountId: undefined });
      await new LobeChatGPTWebAI({ apiKey: 'token-a', client: first as any }).chat(payload);
      await new LobeChatGPTWebAI({ apiKey: 'token-b', client: second as any }).chat(payload);

      expect(first.uploadFile).toHaveBeenCalledTimes(1);
      expect(second.uploadFile).toHaveBeenCalledTimes(1);

      // the SAME token does reuse the cache
      const third = createFakeClient({ accountId: undefined });
      await new LobeChatGPTWebAI({ apiKey: 'token-a', client: third as any }).chat(payload);
      expect(third.uploadFile).not.toHaveBeenCalled();
    });

    it('refuses an oversized remote image', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(PNG_BYTES, {
              headers: {
                'content-length': String(64 * 1024 * 1024),
                'content-type': 'image/png',
              },
              status: 200,
            }),
        ),
      );

      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [
          {
            content: [
              { image_url: { url: 'https://cdn.example/huge.png' }, type: 'image_url' as const },
            ],
            role: 'user' as const,
          },
        ],
        model: 'auto',
        temperature: 1,
      });

      expect(client.uploadFile).not.toHaveBeenCalled();
      expect(bodyOf(client).messages.at(-1).content.parts[0]).toBe(
        '[image omitted: upload failed]',
      );
    });

    it('refuses an oversized data-URI attachment', async () => {
      const client = createFakeClient();
      // 48 MiB of base64 ⇒ ~36 MiB decoded, over the 32 MiB ceiling
      const huge = 'A'.repeat(48 * 1024 * 1024);

      await createRuntime(client).chat({
        messages: [
          {
            content: [
              {
                file_url: {
                  content: 'parsed text',
                  mimeType: 'application/pdf',
                  name: 'huge.pdf',
                  url: `data:application/pdf;base64,${huge}`,
                },
                type: 'file_url',
              },
            ] as any,
            role: 'user',
          },
        ],
        model: 'auto',
        temperature: 1,
      });

      expect(client.uploadFile).not.toHaveBeenCalled();
      expect(bodyOf(client).messages.at(-1).content.parts[0]).toContain(
        '[Attached file: huge.pdf]',
      );
    });

    it('refuses a file_url whose announced size is over the limit', async () => {
      const fetchSpy = vi.fn(
        async () =>
          new Response('x', {
            headers: { 'content-length': String(64 * 1024 * 1024), 'content-type': 'text/plain' },
            status: 200,
          }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [
          {
            content: [
              {
                file_url: {
                  mimeType: 'text/plain',
                  name: 'big.txt',
                  url: 'https://files.example/big.txt?sig=secret',
                },
                type: 'file_url',
              },
            ] as any,
            role: 'user',
          },
        ],
        model: 'auto',
        temperature: 1,
      });

      expect(fetchSpy).toHaveBeenCalled();
      expect(client.uploadFile).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('uploads file_url parts and waits for indexing', async () => {
      const client = createFakeClient();
      await createRuntime(client).chat({
        messages: [
          {
            content: [
              {
                file_url: {
                  content: 'parsed text',
                  mimeType: 'application/pdf',
                  name: 'report.pdf',
                  url: 'data:application/pdf;base64,JVBERi0=',
                },
                type: 'file_url',
              },
              { text: 'summarize', type: 'text' },
            ] as any,
            role: 'user',
          },
        ],
        model: 'auto',
        temperature: 1,
      });

      expect(client.uploadFile).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        expect.objectContaining({ kind: 'document', mimeType: 'application/pdf' }),
        expect.anything(),
      );
      expect(client.waitForFileReady).toHaveBeenCalledWith('file-1', expect.anything());

      const message = bodyOf(client).messages.at(-1);
      expect(message.content.content_type).toBe('text');
      expect(message.metadata.attachments[0]).toMatchObject({
        fileTokenSize: 42,
        id: 'file-1',
        name: 'report.pdf',
      });
    });

    it('falls back to inlining the parsed text when the upload fails', async () => {
      const client = createFakeClient({
        uploadFile: vi.fn(async () => {
          throw new ChatGPTWebError('upstream', 'file creation returned no upload url');
        }),
      });

      await createRuntime(client).chat({
        messages: [
          {
            content: [
              {
                file_url: {
                  content: 'parsed text',
                  mimeType: 'text/plain',
                  name: 'notes.txt',
                  url: 'data:text/plain;base64,aGk=',
                },
                type: 'file_url',
              },
            ] as any,
            role: 'user',
          },
        ],
        model: 'auto',
        temperature: 1,
      });

      const message = bodyOf(client).messages.at(-1);
      expect(message.content.parts[0]).toContain('[Attached file: notes.txt]');
      expect(message.content.parts[0]).toContain('parsed text');
      expect(message.metadata?.attachments).toBeUndefined();
    });

    it('uses the shared placeholder when a failed upload has no parsed text', async () => {
      const client = createFakeClient({
        uploadFile: vi.fn(async () => {
          throw new ChatGPTWebError('upstream', 'file creation returned no upload url');
        }),
      });

      await createRuntime(client).chat({
        messages: [
          {
            content: [
              {
                file_url: {
                  mimeType: 'application/pdf',
                  name: 'report.pdf',
                  url: 'data:application/pdf;base64,aGk=',
                },
                type: 'file_url',
              },
            ] as any,
            role: 'user',
          },
        ],
        model: 'auto',
        temperature: 1,
      });

      expect(bodyOf(client).messages.at(-1).content.parts[0]).toBe('[file omitted: report.pdf]');
    });
  });

  describe('post-turn work', () => {
    it('fetches citations from the conversation document and hides the conversation', async () => {
      const client = createFakeClient({
        getConversation: vi.fn(async () => ({
          mapping: {
            a: {
              message: {
                author: { role: 'assistant' },
                content: { content_type: 'text', parts: ['v24'] },
                create_time: nowSec() + 5,
                metadata: {
                  content_references: [
                    {
                      items: [{ title: 'Node', url: 'https://nodejs.org' }],
                      type: 'grouped_webpages',
                    },
                  ],
                },
              },
            },
          },
        })),
      });

      const response = await createRuntime(client).chat({
        enabledSearch: true,
        messages: [{ content: 'latest node?', role: 'user' }],
        model: 'auto',
        temperature: 1,
      });
      const sse = await readSSE(response);

      expect(client.getConversation).toHaveBeenCalledWith('conv-1', expect.anything());
      expect(sse).toContain('event: grounding');
      expect(sse).toContain('https://nodejs.org');
      expect(client.hideConversation).toHaveBeenCalledWith('conv-1', expect.anything());
    });

    it('recovers the answer from the document when the resume stream brought nothing', async () => {
      const client = createFakeClient({
        // the answer node descends from the user message this very turn sent
        getConversation: vi.fn(async () =>
          documentFor(bodyOf(client), { parts: ['four'], status: 'finished_successfully' }),
        ),
        // a handed-off turn whose resume continuation produced nothing either:
        // the SSE ends right after conversation.start
        streamConversation: vi.fn(async function* () {
          yield { conversationId: 'conv-async', type: 'conversation.start' } as ConversationEvent;
          yield { conversationId: 'conv-async', endTurn: false, type: 'done' } as ConversationEvent;
        }),
      });

      const sse = await readSSE(
        await createRuntime(client).chat({
          messages: [{ content: '2+2? one word', role: 'user' }],
          model: 'gpt-5-6-thinking',
          reasoning_effort: 'high',
          temperature: 1,
        }),
      );

      expect(bodyOf(client).thinking_effort).toBe('extended');
      expect(client.getConversation).toHaveBeenCalled();
      expect(sse).toContain('event: text');
      expect(sse).toContain('"four"');
      expect(sse).toContain('event: stop');
    }, 20_000);

    it('never returns a replayed historical answer as this turn’s answer', async () => {
      // the document only holds a FINISHED assistant message from an earlier
      // turn (another branch, created before this request)
      const historical = {
        mapping: {
          old: {
            message: {
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: ['an answer from last time'] },
              create_time: nowSec() - 3600,
              end_turn: true,
              metadata: {},
              status: 'finished_successfully',
            },
            parent: 'someone-elses-turn',
          },
        },
      };
      const client = createFakeClient({
        getConversation: vi.fn(async () => historical),
        streamConversation: vi.fn(async function* () {
          yield { conversationId: 'conv-async', type: 'conversation.start' } as ConversationEvent;
          yield { conversationId: 'conv-async', endTurn: false, type: 'done' } as ConversationEvent;
        }),
      });

      const runtime = createRuntime(client);
      vi.useFakeTimers();
      try {
        const response = await runtime.chat({
          messages: [{ content: '2+2? one word', role: 'user' }],
          model: 'gpt-5-6-thinking',
          reasoning_effort: 'high',
          temperature: 1,
        });
        const sse = readSSE(response);
        // burn the whole recovery budget without ever accepting the old answer
        await vi.advanceTimersByTimeAsync(250_000);
        const raw = await sse;

        expect(raw).not.toContain('an answer from last time');
        // a recovery that ran out of budget is an error, never a silent success
        expect(raw).toContain('event: error');
        expect(raw).toContain('ProviderNetworkError');
        // the conversation is hidden even when the recovery failed
        expect(client.hideConversation).toHaveBeenCalledWith('conv-async', expect.anything());
      } finally {
        vi.useRealTimers();
      }
    }, 30_000);

    it('recovers only the UNSENT suffix after a failed resume leg', async () => {
      const client = createFakeClient({
        getConversation: vi.fn(async () =>
          documentFor(bodyOf(client), {
            parts: ['the first half and the second half'],
            status: 'finished_successfully',
          }),
        ),
        // the resume leg emitted part of the answer and then broke
        streamConversation: vi.fn(async function* () {
          yield { conversationId: 'conv-cut', type: 'conversation.start' } as ConversationEvent;
          yield {
            delta: 'the first half',
            text: 'the first half',
            type: 'text.delta',
          } as ConversationEvent;
          yield {
            conversationId: 'conv-cut',
            endTurn: false,
            recoveryRequired: true,
            type: 'done',
          } as ConversationEvent;
        }),
      });

      const sse = await readSSE(
        await createRuntime(client).chat({
          messages: [{ content: 'tell me a long thing', role: 'user' }],
          model: 'gpt-5-6-thinking',
          reasoning_effort: 'high',
          temperature: 1,
        }),
      );

      expect(client.getConversation).toHaveBeenCalled();
      // the already-streamed prefix is NOT repeated
      expect(sse).toContain('" and the second half"');
      expect(sse.match(/the first half/g)).toHaveLength(1);
    }, 20_000);

    it('does not poll for an answer when the turn already failed', async () => {
      const client = createFakeClient({
        streamConversation: vi.fn(async function* () {
          yield { conversationId: 'conv-bad', type: 'conversation.start' } as ConversationEvent;
          yield { message: 'upstream exploded', type: 'error' } as ConversationEvent;
          yield { conversationId: 'conv-bad', endTurn: false, type: 'done' } as ConversationEvent;
        }),
      });

      const sse = await readSSE(
        await createRuntime(client).chat({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'auto',
          temperature: 1,
        }),
      );

      expect(sse).toContain('upstream exploded');
      // no 4-minute answer poll piled on top of a failure…
      expect(client.getConversation).not.toHaveBeenCalled();
      // …but the conversation is still hidden
      expect(client.hideConversation).toHaveBeenCalledWith('conv-bad', expect.anything());
    });

    it('hides the conversation even when the caller aborts mid-turn', async () => {
      const controller = new AbortController();
      const client = createFakeClient({
        streamConversation: vi.fn(async function* () {
          yield { conversationId: 'conv-stop', type: 'conversation.start' } as ConversationEvent;
          yield { delta: 'par', text: 'par', type: 'text.delta' } as ConversationEvent;
          controller.abort();
          throw new DOMException('The operation was aborted.', 'AbortError');
        }),
      });

      const sse = await readSSE(
        await createRuntime(client).chat(
          { messages: [{ content: 'hi', role: 'user' }], model: 'auto', temperature: 1 },
          { signal: controller.signal },
        ),
      );

      expect(sse).toContain('event: stop\ndata: "abort"');
      expect(client.getConversation).not.toHaveBeenCalled();
      expect(client.hideConversation).toHaveBeenCalledWith('conv-stop', expect.anything());
    });

    it('reports a timeout raised before the first event as a network error', async () => {
      const client = createFakeClient({
        streamConversation: vi.fn(async function* () {
          throw new ChatGPTWebError('timeout', 'conversation exceeded 300000ms');

          yield undefined as never;
        }),
      });

      await expect(
        createRuntime(client).chat({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'auto',
          temperature: 1,
        }),
      ).rejects.toMatchObject({ errorType: AgentRuntimeErrorType.ProviderNetworkError });
    });

    it('redacts blobs and signed urls from the debug tee', async () => {
      const client = createFakeClient({
        streamConversation: vi.fn(async function* () {
          yield { conversationId: 'conv-9', type: 'conversation.start' } as ConversationEvent;
          yield {
            citations: [{ title: 'Node', url: 'https://nodejs.org/dl?token=SECRET&x=1' }],
            type: 'citations',
          } as ConversationEvent;
          yield {
            assetPointer: 'file-service://img-1',
            fileId: 'img-1',
            pointerKind: 'file-service',
            type: 'image.pointer',
          } as ConversationEvent;
          yield { conversationId: 'conv-9', type: 'done' } as ConversationEvent;
        }),
      });

      process.env.DEBUG_CHATGPTWEB_CHAT_COMPLETION = '1';
      try {
        const response = await createRuntime(client).chat({
          messages: [{ content: 'draw a cat', role: 'user' }],
          model: 'auto',
          temperature: 1,
        });
        // the production half must still carry everything
        const sse = await readSSE(response);
        expect(sse).toContain('data:image/png;base64,');
        expect(sse).toContain('token=SECRET');

        const debugged = await collectStream(vi.mocked(debugStream).mock.calls.at(-1)![0] as any);
        expect(debugged).toContain('<base64_image image/png');
        expect(debugged).not.toContain(PNG_BASE64.slice(0, 16));
        expect(debugged).not.toContain('token=SECRET');
        expect(debugged).toContain('https://nodejs.org/dl?<redacted>');
      } finally {
        delete process.env.DEBUG_CHATGPTWEB_CHAT_COMPLETION;
      }
    });

    it('resolves generated images into base64_image chunks', async () => {
      const client = createFakeClient({
        streamConversation: vi.fn(async function* () {
          yield { conversationId: 'conv-9', type: 'conversation.start' } as ConversationEvent;
          yield {
            assetPointer: 'file-service://img-1',
            fileId: 'img-1',
            pointerKind: 'file-service',
            type: 'image.pointer',
          } as ConversationEvent;
          yield { conversationId: 'conv-9', type: 'done' } as ConversationEvent;
        }),
      });

      const sse = await readSSE(
        await createRuntime(client).chat({
          messages: [{ content: 'draw a cat', role: 'user' }],
          model: 'auto',
          temperature: 1,
        }),
      );

      expect(client.getFileDownloadUrl).toHaveBeenCalledWith('img-1', undefined);
      expect(sse).toContain('event: base64_image');
      expect(sse).toContain('data:image/png;base64,');
    });

    describe('code-interpreter files', () => {
      const PDF_BYTES = new TextEncoder().encode('%PDF-1.4 aihub');

      const withFile = (overrides: Record<string, any> = {}) =>
        createFakeClient({
          downloadBytes: vi.fn(async () => ({ bytes: PDF_BYTES, mimeType: 'application/pdf' })),
          resolveInterpreterFile: vi.fn(async () => ({
            downloadUrl: 'https://chatgpt.com/backend-api/estuary/content?id=file_1&sig=SECRET',
            fileId: 'file_1',
            name: 'aihub-test.pdf',
          })),
          streamConversation: vi.fn(async function* () {
            yield { conversationId: 'conv-9', type: 'conversation.start' } as ConversationEvent;
            yield {
              delta: 'Done: [aihub-test.pdf](sandbox:/mnt/data/aihub-test.pdf)',
              text: 'Done: [aihub-test.pdf](sandbox:/mnt/data/aihub-test.pdf)',
              type: 'text.delta',
            } as ConversationEvent;
            yield {
              conversationId: 'conv-9',
              messageId: 'answer-1',
              name: 'aihub-test.pdf',
              sandboxPath: '/mnt/data/aihub-test.pdf',
              type: 'file.pointer',
            } as ConversationEvent;
            yield { conversationId: 'conv-9', type: 'done' } as ConversationEvent;
          }),
          ...overrides,
        });

      const runFileTurn = async (client: any) =>
        readSSE(
          await createRuntime(client).chat({
            messages: [{ content: 'make me a pdf', role: 'user' }],
            model: 'auto',
            temperature: 1,
          }),
        );

      it('downloads the interpreter output and emits a file chunk', async () => {
        const client = withFile();
        const sse = await runFileTurn(client);

        expect(client.resolveInterpreterFile).toHaveBeenCalledWith({
          conversationId: 'conv-9',
          messageId: 'answer-1',
          sandboxPath: '/mnt/data/aihub-test.pdf',
          signal: undefined,
        });
        // the whole file is bounded like every other asset we pull
        expect(client.downloadBytes).toHaveBeenCalledWith(
          'https://chatgpt.com/backend-api/estuary/content?id=file_1&sig=SECRET',
          { maxBytes: 32 * 1024 * 1024, signal: undefined },
        );
        expect(sse).toContain('event: file');

        const line = sse.split('\n').find((item) => item.includes('"mimeType"'))!;
        expect(JSON.parse(line.slice('data: '.length))).toEqual({
          data: `data:application/pdf;base64,${bytesToBase64(PDF_BYTES)}`,
          mimeType: 'application/pdf',
          name: 'aihub-test.pdf',
          size: PDF_BYTES.length,
          sourcePath: '/mnt/data/aihub-test.pdf',
        });
        // the answer text is delivered untouched
        expect(sse).toContain('sandbox:/mnt/data/aihub-test.pdf');
      });

      it('names the type from the extension when the host answers with a generic one', async () => {
        const client = withFile({
          downloadBytes: vi.fn(async () => ({
            bytes: PDF_BYTES,
            mimeType: 'binary/octet-stream',
          })),
          resolveInterpreterFile: vi.fn(async () => ({
            downloadUrl: 'https://chatgpt.com/backend-api/estuary/content?id=file_2',
            name: 'notes.docx',
          })),
        });

        const sse = await runFileTurn(client);

        expect(sse).toContain(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
      });

      it('keeps the answer when the download is over the size cap', async () => {
        const client = withFile({
          downloadBytes: vi.fn(async () => {
            throw new ChatGPTWebError('upstream', 'asset exceeds the 33554432 byte limit');
          }),
        });

        const sse = await runFileTurn(client);

        expect(sse).not.toContain('event: file\n');
        expect(sse).toContain('event: stop');
        expect(sse).toContain('Done: [aihub-test.pdf]');
      });

      it('resolves a recovered answer’s files before hiding the conversation, keyed by its message', async () => {
        // a handed-off turn: the stream carried nothing, so the sandbox link
        // only ever exists in the recovered document
        const client: any = withFile({
          getConversation: vi.fn(async () => ({
            mapping: {
              [userMessageIdOf(bodyOf(client))]: { message: { author: { role: 'user' } } },
              answer: {
                message: {
                  author: { role: 'assistant' },
                  content: {
                    content_type: 'text',
                    parts: ['Done: [aihub-test.pdf](sandbox:/mnt/data/aihub-test.pdf)'],
                  },
                  create_time: nowSec(),
                  end_turn: true,
                  id: 'answer-doc-1',
                  metadata: {},
                  status: 'finished_successfully',
                },
                parent: userMessageIdOf(bodyOf(client)),
              },
            },
          })),
          streamConversation: vi.fn(async function* () {
            yield { conversationId: 'conv-9', type: 'conversation.start' } as ConversationEvent;
            yield { conversationId: 'conv-9', endTurn: false, type: 'done' } as ConversationEvent;
          }),
        });

        const sse = await runFileTurn(client);

        expect(client.resolveInterpreterFile).toHaveBeenCalledWith({
          conversationId: 'conv-9',
          messageId: 'answer-doc-1',
          sandboxPath: '/mnt/data/aihub-test.pdf',
          signal: undefined,
        });
        // the chunk carries the upstream assistant message id, like a streamed one
        expect(sse).toContain('id: answer-doc-1\nevent: file');
        // …and the bytes were pulled while the conversation was still readable
        expect(client.downloadBytes.mock.invocationCallOrder[0]).toBeLessThan(
          client.hideConversation.mock.invocationCallOrder[0],
        );
      }, 20_000);

      it('redacts the file payload from the debug tee', async () => {
        const client = withFile();
        process.env.DEBUG_CHATGPTWEB_CHAT_COMPLETION = '1';
        try {
          await runFileTurn(client);
          const debugged = await collectStream(vi.mocked(debugStream).mock.calls.at(-1)![0] as any);
          expect(debugged).toContain('<file application/pdf');
          expect(debugged).not.toContain(bytesToBase64(PDF_BYTES));
        } finally {
          delete process.env.DEBUG_CHATGPTWEB_CHAT_COMPLETION;
        }
      });
    });
  });

  describe('errors', () => {
    it('maps a 401 to OAuthAuthorizationExpired', async () => {
      const client = createFakeClient({
        getChatRequirements: vi.fn(async () => {
          throw new ChatGPTWebError('auth', 'me failed: status=401', { status: 401 });
        }),
      });

      await expect(
        createRuntime(client).chat({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'auto',
          temperature: 1,
        }),
      ).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.OAuthAuthorizationExpired,
        provider: 'chatgptweb',
      });
    });

    it('explains a missing transport', async () => {
      const client = createFakeClient({
        getChatRequirements: vi.fn(async () => {
          throw new ChatGPTWebError('transport_unavailable', 'curl-impersonate not found');
        }),
      });

      await expect(
        createRuntime(client).chat({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'auto',
          temperature: 1,
        }),
      ).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.ProviderBizError,
        message: expect.stringContaining('curl-impersonate'),
      });
    });

    it('never forwards an upstream body into the runtime error', async () => {
      const client = createFakeClient({
        getChatRequirements: vi.fn(async () => {
          throw new ChatGPTWebError('upstream', 'conversation failed: status=500', {
            body: { detail: 'boom', message: 'a whole conversation turn the user typed' },
            code: 'CHATGPT_WEB_UPSTREAM',
            status: 500,
          });
        }),
      });

      const error = await createRuntime(client)
        .chat({ messages: [{ content: 'hi', role: 'user' }], model: 'auto', temperature: 1 })
        .catch((raised: any) => raised);

      expect(error.error).toEqual({
        code: 'CHATGPT_WEB_UPSTREAM',
        kind: 'upstream',
        message: 'conversation failed: status=500',
        status: 500,
      });
      expect(JSON.stringify(error)).not.toContain('a whole conversation turn');
    });

    it('keeps a cancellation raised before the first event as an abort', async () => {
      const controller = new AbortController();
      const client = createFakeClient({
        streamConversation: vi.fn(async function* () {
          controller.abort();
          throw new DOMException('The operation was aborted.', 'AbortError');

          yield undefined as never;
        }),
      });

      const response = await createRuntime(client).chat(
        { messages: [{ content: 'hi', role: 'user' }], model: 'auto', temperature: 1 },
        { signal: controller.signal },
      );

      const sse = await readSSE(response);
      expect(sse).toContain('event: stop\ndata: "abort"');
      expect(sse).not.toContain('event: error');
    });

    it('surfaces an upstream 401 raised on the first stream event', async () => {
      const client = createFakeClient({
        streamConversation: vi.fn(async function* () {
          throw new ChatGPTWebError('auth', 'conversation failed: status=401', { status: 401 });

          yield undefined as never;
        }),
      });

      await expect(
        createRuntime(client).chat({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'auto',
          temperature: 1,
        }),
      ).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.OAuthAuthorizationExpired,
      });
    });
  });

  describe('models', () => {
    it('collapses Instant/Thinking/Pro SKUs into one family card and hides internals', async () => {
      const client = createFakeClient({
        listModels: vi.fn(async () => [
          { maxTokens: 128_000, raw: {}, slug: 'gpt-5-6', title: 'GPT-5.6' },
          { maxTokens: 128_000, raw: {}, slug: 'gpt-5-6-thinking', title: 'GPT-5.6 Thinking' },
          { raw: {}, slug: 'gpt-5.6-sol-wm', title: 'watermarked' },
          { raw: {}, slug: 'research', title: 'Research' },
        ]),
      });

      const models = await createRuntime(client).models();

      expect(models.map((model) => model.id)).toEqual(['gpt-5-6']);
      expect(models[0]).toMatchObject({
        contextWindowTokens: 128_000,
        displayName: 'GPT-5.6 Sol (ChatGPT Web)',
        enabled: true,
        functionCall: false,
        id: 'gpt-5-6',
        reasoning: true,
        settings: expect.objectContaining({ extendParams: ['chatgptWebReasoningEffort'] }),
      });
    });

    it('enables the advertised family set, not Instant/Thinking/Pro SKUs', async () => {
      const client = createFakeClient({
        listModels: vi.fn(async () => [
          { raw: {}, slug: 'gpt-5-6' },
          { raw: {}, slug: 'gpt-5-6-thinking' },
          { raw: {}, slug: 'gpt-5-6-pro' },
          { raw: {}, slug: 'gpt-5-6-instant' },
          { raw: {}, slug: 'gpt-5-5' },
          { raw: {}, slug: 'o3' },
          { raw: {}, slug: 'gpt-5-6-mini' },
        ]),
      });

      const models = await createRuntime(client).models();
      const enabled = models.filter((model) => model.enabled).map((model) => model.id);

      expect(enabled).toEqual(['gpt-5-6', 'gpt-5-5', 'o3']);
      expect(models.map((model) => model.id)).toEqual(['gpt-5-6', 'gpt-5-5', 'o3', 'gpt-5-6-mini']);
      expect(models.find((model) => model.id === 'gpt-5-6')).toMatchObject({ reasoning: true });
      expect(models.find((model) => model.id === 'o3')).toMatchObject({
        reasoning: true,
        settings: expect.not.objectContaining({
          extendParams: expect.arrayContaining(['chatgptWebReasoningEffort']),
        }),
      });
      expect(models.find((model) => model.id === 'gpt-5-6-mini')).toMatchObject({
        enabled: false,
        id: 'gpt-5-6-mini',
      });
    });

    it('collapses a live-only family and derives the display name from SKU titles', async () => {
      const client = createFakeClient({
        listModels: vi.fn(async () => [
          { raw: {}, slug: 'gpt-5-7-thinking', title: 'GPT-5.7 Thinking' },
          { raw: {}, slug: 'gpt-5-7-instant', title: 'GPT-5.7 Instant' },
        ]),
      });

      const models = await createRuntime(client).models();

      expect(models.map((model) => model.id)).toEqual(['gpt-5-7']);
      expect(models[0]).toMatchObject({
        contextWindowTokens: 128_000,
        displayName: 'GPT-5.7',
        enabled: false,
        files: true,
        functionCall: false,
        reasoning: true,
        search: true,
        settings: {
          extendParams: ['chatgptWebReasoningEffort'],
          searchImpl: 'params',
          searchProvider: 'chatgptweb',
        },
        vision: true,
      });
    });
  });
});

describe('debug logging', () => {
  it('describes a request structurally, never its content', () => {
    const described = describeRequestBody(
      {
        messages: [
          {
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['MY SECRET PROMPT and the whole file text'] },
            metadata: { attachments: [{ id: 'file-1', name: 'salaries.xlsx' }] },
          },
        ],
        model: 'auto',
        system_hints: ['search'],
      },
      { flow: 'f:search', model: 'auto', thinkingEffort: 'extended' },
    );

    const serialized = JSON.stringify(described);
    expect(serialized).not.toContain('MY SECRET PROMPT');
    expect(serialized).not.toContain('salaries.xlsx');
    expect(described).toMatchObject({
      flow: 'f:search',
      hasAttachments: true,
      messageCount: 1,
      roles: ['user'],
    });
  });
});

describe('undeliveredSuffix', () => {
  it.each([
    ['nothing streamed yet', 'the whole answer', '', 'the whole answer'],
    ['a streamed prefix', 'half and half', 'half ', 'and half'],
    ['an exact match', 'all of it', 'all of it', ''],
    ['a leading marker the stream dropped', '\u200Bhalf and half', 'half ', 'and half'],
    ['a divergent document', 'something else', 'half ', ''],
  ])('handles %s', (_label, recovered, streamed, expected) => {
    expect(undeliveredSuffix(recovered, streamed)).toBe(expected);
  });
});
