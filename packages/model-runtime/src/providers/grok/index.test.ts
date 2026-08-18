// @vitest-environment node
import { ModelProvider } from 'model-bank';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveConversationSessionId, deriveGrokAgentId } from '../../browserProfile';
import { OpenAIResponsesStream } from '../../core/streams';
import { createReadableStream, readStreamChunk } from '../../core/streams/utils';
import { testProvider } from '../../providerTestUtils';
import {
  GROK_AUTHENTICATE_RESPONSE,
  GROK_CLIENT_IDENTIFIER,
  GROK_CLIENT_MODE,
  GROK_CLIENT_VERSION,
  GROK_DEFAULT_USER_AGENT_PLATFORM,
  GROK_IDENTITY_MISSING_MESSAGE,
  GROK_TOKEN_AUTH,
  LobeGrokAI,
} from './index';

vi.mock('@lobechat/business-model-bank/model-config', () => ({
  loadModels: vi.fn().mockResolvedValue([]),
}));

const GROK_PROXY_MODELS = {
  data: [
    {
      api_backend: 'responses',
      context_window: 500_000,
      description: "SpaceXAI's latest frontier model",
      id: 'grok-4.6',
      name: 'Grok 4.6',
      reasoning_efforts: [{ id: 'xhigh' }, { id: 'high' }, { id: 'medium' }, { id: 'low' }],
      supports_backend_search: true,
      supports_reasoning_effort: true,
    },
    {
      context_window: 500_000,
      id: 'grok-4.5',
      name: 'Grok 4.5',
      reasoning_efforts: [{ id: 'high' }, { id: 'medium' }, { id: 'low' }],
    },
  ],
};
const INSTALLATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const CONVERSATION_KEY = 'thread-1';
const FIRST_SEEN_MS = 1_700_000_000;

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const headerRecord = (input: RequestInfo | URL, init?: RequestInit): Record<string, string> => {
  const merged = new Headers();
  if (typeof input !== 'string' && !(input instanceof URL) && 'headers' in input && input.headers) {
    new Headers(input.headers).forEach((value, key) => merged.set(key, value));
  }
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => merged.set(key, value));
  }
  const result: Record<string, string> = {};
  merged.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

const requestBody = (init?: RequestInit): Record<string, any> => {
  expect(typeof init?.body).toBe('string');
  return JSON.parse(init?.body as string);
};

const expectNoStainlessHeaders = (headers: Record<string, string>) => {
  expect(Object.keys(headers).filter((key) => key.startsWith('x-stainless-'))).toEqual([]);
  expect(headers['user-agent']).not.toContain('OpenAI/JS');
};

const expectGrokResponsesHeaders = (headers: Record<string, string>) => {
  expect(headers['accept']).toBe('text/event-stream');
  expect(headers['user-agent']).toBe(
    `grok-shell/${GROK_CLIENT_VERSION} (${GROK_DEFAULT_USER_AGENT_PLATFORM})`,
  );
  expect(headers['x-authenticateresponse']).toBe(GROK_AUTHENTICATE_RESPONSE);
  expect(headers['x-grok-agent-id']).toBe(deriveGrokAgentId(INSTALLATION_ID));
  expect(headers['x-grok-client-identifier']).toBe(GROK_CLIENT_IDENTIFIER);
  expect(headers['x-grok-client-mode']).toBe(GROK_CLIENT_MODE);
  expect(headers['x-grok-client-version']).toBe(GROK_CLIENT_VERSION);
  expect(headers['x-grok-conv-id']).toBe(
    deriveConversationSessionId(CONVERSATION_KEY, FIRST_SEEN_MS),
  );
  expect(headers['x-grok-doom-loop-check']).toBe('1024');
  expect(headers['x-grok-model-override']).toBe('grok-4.6');
  expect(headers['x-grok-session-id']).toBe(headers['x-grok-conv-id']);
  expect(headers['x-grok-turn-idx']).toBe('1');
  expect(headers['x-grok-user-id']).toBe('acct-principal');
  expect(headers['x-xai-token-auth']).toBe(GROK_TOKEN_AUTH);
  expect(headers['traceparent']).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-01$/);
  expect(headers['x-grok-req-id']).toMatch(
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
  );
  expectNoStainlessHeaders(headers);
};

testProvider({
  Runtime: LobeGrokAI,
  provider: ModelProvider.Grok,
  defaultBaseURL: 'https://cli-chat-proxy.grok.com/v1',
  chatDebugEnv: 'DEBUG_GROK_CHAT_COMPLETION',
  responseDebugEnv: 'DEBUG_GROK_RESPONSES',
  chatModel: 'grok-4.6',
  // The runtime refuses to build a request without the installation's device id.
  runtimeParams: { installationId: INSTALLATION_ID },
  test: { useResponsesAPI: true },
});

describe('LobeGrokAI', () => {
  let instance: InstanceType<typeof LobeGrokAI>;

  beforeEach(() => {
    instance = new LobeGrokAI({
      apiKey: 'access-token',
      conversationKey: CONVERSATION_KEY,
      firstSeenMs: FIRST_SEEN_MS,
      installationId: INSTALLATION_ID,
    });
    vi.spyOn(instance['client'].chat.completions, 'create').mockResolvedValue(
      new ReadableStream() as never,
    );
    vi.spyOn(instance['client'].responses, 'create').mockResolvedValue(
      new ReadableStream() as never,
    );
  });

  it('configures the CLI proxy base URL and mandatory Grok CLI headers', () => {
    const headers = instance['client']['_options'].defaultHeaders;

    expect(instance.baseURL).toBe('https://cli-chat-proxy.grok.com/v1');
    expect(instance['client'].apiKey).toBe('access-token');
    expect(headers).toEqual(
      expect.objectContaining({
        'Accept': '*/*',
        'User-Agent': `grok-shell/${GROK_CLIENT_VERSION} (${GROK_DEFAULT_USER_AGENT_PLATFORM})`,
      }),
    );
    expect(headers).not.toHaveProperty('x-grok-client-identifier');
    expect(headers).not.toHaveProperty('x-grok-client-version');
  });

  it('always uses Responses API and maps reasoning effort + summary + Grok body fields', async () => {
    await instance.chat({
      messages: [
        { content: 'Follow the instructions', role: 'system' },
        { content: 'Hello', role: 'user' },
      ],
      model: 'grok-4.6',
      reasoning_effort: 'xhigh',
      stream: true,
    });

    const [request] = (instance['client'].responses.create as Mock).mock.calls[0];

    expect(request).toMatchObject({
      include: ['reasoning.encrypted_content'],
      input: [
        expect.objectContaining({ content: 'Follow the instructions', role: 'system' }),
        expect.objectContaining({ content: 'Hello', role: 'user' }),
      ],
      model: 'grok-4.6',
      prompt_cache_key: deriveConversationSessionId(CONVERSATION_KEY, FIRST_SEEN_MS),
      reasoning: { effort: 'xhigh', summary: 'auto' },
      store: false,
      stream: true,
    });
    expect(request).not.toHaveProperty('instructions');
    expect(request).not.toHaveProperty('safety_identifier');
    expect(request).not.toHaveProperty('user');
    expect(request).not.toHaveProperty('metadata');
    expect(request).not.toHaveProperty('service_tier');
    expect(instance['client'].chat.completions.create).not.toHaveBeenCalled();
  });

  it('routes chatCompletion apiMode to Responses', async () => {
    await instance.chat({
      apiMode: 'chatCompletion',
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'grok-4.6',
      stream: true,
    } as never);

    expect(instance['client'].responses.create).toHaveBeenCalled();
    expect(instance['client'].chat.completions.create).not.toHaveBeenCalled();
  });

  it('keeps max_output_tokens handling for Responses requests', async () => {
    await instance.chat({
      max_tokens: 4096,
      messages: [{ content: 'Hello', role: 'user' }],
      model: 'grok-4.6',
      stream: true,
    });

    const [request] = (instance['client'].responses.create as Mock).mock.calls[0];

    expect(request.max_output_tokens).toBe(4096);
    expect(request.reasoning).toEqual({ summary: 'auto' });
  });

  it('emits reasoning chunks from streamed reasoning summary deltas', async () => {
    const chunks = await readStreamChunk(
      OpenAIResponsesStream(
        createReadableStream([
          {
            response: { id: 'resp_grok', status: 'in_progress' },
            type: 'response.created',
          },
          {
            delta: 'The user asked for a single-word reply.',
            item_id: 'rs_grok',
            output_index: 0,
            summary_index: 0,
            type: 'response.reasoning_summary_text.delta',
          },
          {
            delta: 'pong',
            item_id: 'msg_grok',
            output_index: 1,
            type: 'response.output_text.delta',
          },
        ]),
      ),
    );

    expect(chunks.some((chunk) => chunk.includes('event: reasoning'))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('The user asked for a single-word reply.'))).toBe(
      true,
    );
    expect(chunks.some((chunk) => chunk.includes('event: text'))).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('pong'))).toBe(true);
  });

  it('preserves summary-only reasoning for non-streaming Grok responses', async () => {
    const grokNonStreamResponse = {
      created_at: 1_755_000_000,
      id: 'resp_grok_ns',
      model: 'grok-4.6-build',
      object: 'response',
      output: [
        {
          id: 'rs_grok',
          summary: [{ text: 'The user asked for a single-word reply.', type: 'summary_text' }],
          type: 'reasoning',
        },
        {
          content: [{ text: 'pong', type: 'output_text' }],
          id: 'msg_grok',
          role: 'assistant',
          status: 'completed',
          type: 'message',
        },
      ],
      status: 'completed',
      usage: {
        input_tokens: 12,
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 16 },
        total_tokens: 32,
      },
    };

    (instance['client'].responses.create as Mock).mockResolvedValue(grokNonStreamResponse);

    const response = await instance.chat({
      messages: [{ content: 'Reply with the single word pong', role: 'user' }],
      model: 'grok-4.6',
      stream: false,
    });
    const body = await response.text();

    expect(body).toContain('event: text');
    expect(body).toContain('pong');
    expect(body).toContain('event: reasoning_response_item');
    expect(body).toContain('The user asked for a single-word reply.');
    expect(instance['client'].chat.completions.create).not.toHaveBeenCalled();
  });

  describe('installation identity', () => {
    it('refuses to send a request when no installation id was supplied', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response('{}', { status: 200 }),
      );
      const runtime = new LobeGrokAI({
        apiKey: 'access-token',
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
      });

      await expect(
        runtime.chat({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'grok-4.6',
          stream: true,
        }),
      ).rejects.toMatchObject({
        errorType: 'ProviderBizError',
        message: GROK_IDENTITY_MISSING_MESSAGE,
      });
      // Nothing left the process: no request was made with a made-up device id.
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refuses a malformed installation id instead of hashing it anyway', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response('{}', { status: 200 }),
      );
      const runtime = new LobeGrokAI({
        apiKey: 'access-token',
        fetch: fetchImpl,
        installationId: 'not-a-uuid',
      });

      await expect(
        runtime.chat({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'grok-4.6',
          stream: true,
        }),
      ).rejects.toMatchObject({ errorType: 'ProviderBizError' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    /**
     * Structured output and forced tool calling refuse the request in the same place as
     * chat, so they must surface the SAME provider error — the factory's generic branch
     * would otherwise rethrow the raw exception for its business-error type.
     */
    it('surfaces the identity failure as a provider error from generateObject too', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response('{}', { status: 200 }),
      );
      const runtime = new LobeGrokAI({
        apiKey: 'access-token',
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
      });

      await expect(
        runtime.generateObject({
          messages: [{ content: 'Extract the city', role: 'user' }],
          model: 'grok-4.6',
          schema: {
            name: 'location',
            schema: {
              properties: { city: { type: 'string' } },
              required: ['city'],
              type: 'object',
            },
          },
        }),
      ).rejects.toMatchObject({
        errorType: 'ProviderBizError',
        message: GROK_IDENTITY_MISSING_MESSAGE,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('surfaces the identity failure as a provider error from forced tool calling too', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response('{}', { status: 200 }),
      );
      const runtime = new LobeGrokAI({
        apiKey: 'access-token',
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
      });

      await expect(
        runtime.generateObject({
          messages: [{ content: 'The city is Hangzhou.', role: 'user' }],
          model: 'grok-4.6',
          tools: [
            {
              function: {
                name: 'extract',
                parameters: { properties: { city: { type: 'string' } }, type: 'object' },
              },
              type: 'function',
            },
          ],
        } as never),
      ).rejects.toMatchObject({
        errorType: 'ProviderBizError',
        message: GROK_IDENTITY_MISSING_MESSAGE,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('starts the session at "now" when the caller passes no first-seen time', async () => {
      const now = Date.UTC(2026, 7, 18, 3, 0, 0);
      vi.setSystemTime(now);
      try {
        const runtime = new LobeGrokAI({
          apiKey: 'access-token',
          conversationKey: 'fresh-conversation',
          installationId: INSTALLATION_ID,
        });
        vi.spyOn(runtime['client'].responses, 'create').mockResolvedValue(
          new ReadableStream() as never,
        );

        await runtime.chat({
          messages: [{ content: 'Hello', role: 'user' }],
          model: 'grok-4.6',
          stream: true,
        });

        const [request] = (runtime['client'].responses.create as Mock).mock.calls[0];
        // The 48 high bits of a UUIDv7 are the creation time — it must be this session's.
        const timestamp = Number.parseInt(
          request.prompt_cache_key.replaceAll('-', '').slice(0, 12),
          16,
        );
        expect(timestamp).toBe(now);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('wire shape', () => {
    it('declares SSE only on the streaming call', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ id: 'resp', output: [], status: 'completed' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          }),
      );
      const runtime = new LobeGrokAI({
        apiKey: 'access-token',
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
        firstSeenMs: FIRST_SEEN_MS,
        installationId: INSTALLATION_ID,
      });

      await runtime.chat({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'grok-4.6',
        stream: false,
      });
      expect(headerRecord(fetchImpl.mock.calls[0][0], fetchImpl.mock.calls[0][1])['accept']).toBe(
        'application/json',
      );

      await runtime.chat({
        messages: [{ content: 'Hello', role: 'user' }],
        model: 'grok-4.6',
        stream: true,
      });
      expect(headerRecord(fetchImpl.mock.calls[1][0], fetchImpl.mock.calls[1][1])['accept']).toBe(
        'text/event-stream',
      );
    });

    it('sends structured output through /v1/responses with the same CLI header block', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              id: 'resp_obj',
              output: [
                {
                  content: [{ text: '{"city":"Hangzhou"}', type: 'output_text' }],
                  role: 'assistant',
                  status: 'completed',
                  type: 'message',
                },
              ],
              output_text: '{"city":"Hangzhou"}',
              status: 'completed',
            }),
            { headers: { 'Content-Type': 'application/json' }, status: 200 },
          ),
      );
      const runtime = new LobeGrokAI({
        apiKey: 'access-token',
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
        firstSeenMs: FIRST_SEEN_MS,
        installationId: INSTALLATION_ID,
      });

      const result = await runtime.generateObject(
        {
          messages: [{ content: 'Extract the city', role: 'user' }],
          model: 'grok-4.6',
          schema: {
            name: 'location',
            schema: {
              properties: { city: { type: 'string' } },
              required: ['city'],
              type: 'object',
            },
          },
        },
        { user: 'platform-user-id' },
      );

      expect(result).toEqual({ city: 'Hangzhou' });
      const [input, init] = fetchImpl.mock.calls[0];
      expect(requestUrl(input)).toContain('/responses');
      expect(requestUrl(input)).not.toContain('/chat/completions');
      const headers = headerRecord(input, init);
      expect(headers['accept']).toBe('application/json');
      expect(headers['x-grok-agent-id']).toBe(deriveGrokAgentId(INSTALLATION_ID));
      expect(headers['x-grok-session-id']).toBe(
        deriveConversationSessionId(CONVERSATION_KEY, FIRST_SEEN_MS),
      );
      expect(headers['x-grok-client-version']).toBe(GROK_CLIENT_VERSION);
      expectNoStainlessHeaders(headers);
      const body = requestBody(init);
      expect(body.prompt_cache_key).toBe(headers['x-grok-session-id']);
      expect(body).not.toHaveProperty('safety_identifier');
      expect(body).not.toHaveProperty('user');
    });

    it('sends forced tool calling through /v1/responses with the CLI header block too', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              id: 'resp_tools',
              output: [
                {
                  arguments: '{"city":"Hangzhou"}',
                  call_id: 'call_1',
                  name: 'extract',
                  type: 'function_call',
                },
              ],
              status: 'completed',
            }),
            { headers: { 'Content-Type': 'application/json' }, status: 200 },
          ),
      );
      const runtime = new LobeGrokAI({
        apiKey: 'access-token',
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
        firstSeenMs: FIRST_SEEN_MS,
        installationId: INSTALLATION_ID,
      });

      await runtime.generateObject({
        messages: [{ content: 'The city is Hangzhou.', role: 'user' }],
        model: 'grok-4.6',
        tools: [
          {
            function: {
              name: 'extract',
              parameters: { properties: { city: { type: 'string' } }, type: 'object' },
            },
            type: 'function',
          },
        ],
      } as never);

      const [input, init] = fetchImpl.mock.calls[0];
      expect(requestUrl(input)).toContain('/responses');
      const headers = headerRecord(input, init);
      expect(headers['x-grok-agent-id']).toBe(deriveGrokAgentId(INSTALLATION_ID));
      expect(headers['x-grok-session-id']).toBe(
        deriveConversationSessionId(CONVERSATION_KEY, FIRST_SEEN_MS),
      );
      expect(headers['accept']).toBe('application/json');
      expectNoStainlessHeaders(headers);
    });

    it('normalizes EVERY system item to the CLI message shape, not just the first', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ error: { message: 'stub' } }), {
            headers: { 'Content-Type': 'application/json' },
            status: 400,
          }),
      );
      const runtime = new LobeGrokAI({
        apiKey: 'access-token',
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
        firstSeenMs: FIRST_SEEN_MS,
        installationId: INSTALLATION_ID,
      });

      await expect(
        runtime.chat({
          messages: [
            { content: 'first system', role: 'system' },
            { content: 'second system', role: 'system' },
            { content: 'Hello', role: 'user' },
          ],
          model: 'grok-4.6',
          stream: true,
        }),
      ).rejects.toBeDefined();

      const body = requestBody(fetchImpl.mock.calls[0][1]);
      expect(body.input).toEqual([
        { content: 'first system', role: 'system', type: 'message' },
        { content: 'second system', role: 'system', type: 'message' },
        expect.objectContaining({ content: 'Hello', role: 'user' }),
      ]);
      expect(JSON.stringify(body.input)).not.toContain('developer');
    });

    it('never lets the turn index go backwards when history is truncated', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ error: { message: 'stub' } }), {
            headers: { 'Content-Type': 'application/json' },
            status: 400,
          }),
      );
      const runtime = new LobeGrokAI({
        apiKey: 'access-token',
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
        firstSeenMs: FIRST_SEEN_MS,
        installationId: INSTALLATION_ID,
        // Server-side counter: this is turn 7 of the conversation…
        turnIndex: 7,
      });

      await expect(
        runtime.chat({
          // …even though history was summarized down to a single user message.
          messages: [{ content: 'Hello again', role: 'user' }],
          model: 'grok-4.6',
          stream: true,
        }),
      ).rejects.toBeDefined();

      expect(
        headerRecord(fetchImpl.mock.calls[0][0], fetchImpl.mock.calls[0][1])['x-grok-turn-idx'],
      ).toBe('7');
    });

    it('uses the payload user-message count when the counter is behind (cold process)', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ error: { message: 'stub' } }), {
            headers: { 'Content-Type': 'application/json' },
            status: 400,
          }),
      );
      const runtime = new LobeGrokAI({
        apiKey: 'access-token',
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
        firstSeenMs: FIRST_SEEN_MS,
        installationId: INSTALLATION_ID,
        turnIndex: 1,
      });

      await expect(
        runtime.chat({
          messages: [
            { content: 'one', role: 'user' },
            { content: 'two', role: 'user' },
            { content: 'three', role: 'user' },
          ],
          model: 'grok-4.6',
          stream: true,
        }),
      ).rejects.toBeDefined();

      expect(
        headerRecord(fetchImpl.mock.calls[0][0], fetchImpl.mock.calls[0][1])['x-grok-turn-idx'],
      ).toBe('3');
    });
  });

  describe('models', () => {
    it('maps the CLI proxy /v1/models shape onto grok-4.5 and grok-4.6', async () => {
      vi.spyOn(instance['client'].models, 'list').mockResolvedValue(GROK_PROXY_MODELS as never);

      const models = await instance.models();

      expect(instance['client'].models.list).toHaveBeenCalled();
      expect(models.map((model) => model.id).sort()).toEqual(['grok-4.5', 'grok-4.6']);
      expect(models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            contextWindowTokens: 500_000,
            displayName: 'Grok 4.5',
            functionCall: true,
            id: 'grok-4.5',
            reasoning: true,
            vision: true,
          }),
          expect.objectContaining({
            contextWindowTokens: 500_000,
            displayName: 'Grok 4.6',
            functionCall: true,
            id: 'grok-4.6',
            reasoning: true,
            vision: true,
          }),
        ]),
      );
    });

    it('carries description, backend search, and the effort list through to abilities/settings', async () => {
      vi.spyOn(instance['client'].models, 'list').mockResolvedValue(GROK_PROXY_MODELS as never);

      const models = await instance.models();
      const grok46 = models.find((model) => model.id === 'grok-4.6');
      const grok45 = models.find((model) => model.id === 'grok-4.5');

      expect(grok46).toEqual(
        expect.objectContaining({
          description: "SpaceXAI's latest frontier model",
          id: 'grok-4.6',
          reasoning: true,
          search: true,
          settings: expect.objectContaining({
            extendParams: ['grok4_20ReasoningEffort'],
            searchImpl: 'params',
          }),
        }),
      );
      expect(grok45).toEqual(
        expect.objectContaining({
          id: 'grok-4.5',
          reasoning: true,
          settings: expect.objectContaining({
            extendParams: ['grok4_5ReasoningEffort'],
          }),
        }),
      );
    });

    it('picks the reasoning-effort param from the effort list, not the model id', async () => {
      vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
        data: [
          {
            id: 'grok-4.5',
            name: 'Grok 4.5 with xhigh',
            reasoning_efforts: [{ id: 'xhigh' }, { id: 'high' }],
            supports_reasoning_effort: true,
          },
          {
            id: 'grok-4.6',
            name: 'Grok 4.6 without xhigh',
            reasoning_efforts: ['high', 'medium', 'low'],
          },
        ],
      } as never);

      const models = await instance.models();

      expect(models.find((model) => model.id === 'grok-4.5')?.settings?.extendParams).toEqual([
        'grok4_20ReasoningEffort',
      ]);
      expect(models.find((model) => model.id === 'grok-4.6')?.settings?.extendParams).toEqual([
        'grok4_5ReasoningEffort',
      ]);
    });

    it('falls back to xai keyword inference when the proxy is silent', async () => {
      vi.spyOn(instance['client'].models, 'list').mockResolvedValue({
        data: [{ id: 'grok-keyword-only-test-model' }],
      } as never);

      const models = await instance.models();

      expect(models).toEqual([
        expect.objectContaining({
          functionCall: true,
          id: 'grok-keyword-only-test-model',
          reasoning: false,
          search: false,
          vision: false,
        }),
      ]);
    });
  });

  describe('request capture', () => {
    const jwtAccessToken = `eyJhbGciOiJub25lIn0.eyJwcmluY2lwYWxfaWQiOiJhY2N0LXByaW5jaXBhbCIsInN1YiI6ImFjY3Qtc3ViIn0.sig`;

    it('sends Grok CLI headers on /v1/responses even when apiMode is chatCompletion', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({ error: { message: 'stub', type: 'invalid_request_error' } }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 400,
            },
          ),
      );
      const runtime = new LobeGrokAI({
        apiKey: jwtAccessToken,
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
        firstSeenMs: FIRST_SEEN_MS,
        installationId: INSTALLATION_ID,
      });

      await expect(
        runtime.chat({
          apiMode: 'chatCompletion',
          messages: [
            { content: 'Follow the instructions', role: 'system' },
            { content: 'Hello', role: 'user' },
          ],
          model: 'grok-4.6',
          stream: true,
        } as never),
      ).rejects.toBeDefined();

      expect(fetchImpl).toHaveBeenCalled();
      const [input, init] = fetchImpl.mock.calls[0];
      const url = requestUrl(input);
      expect(url).toContain('/responses');
      expect(url).not.toContain('/chat/completions');
      expectGrokResponsesHeaders(headerRecord(input, init));

      const body = requestBody(init);
      expect(body).toMatchObject({
        include: ['reasoning.encrypted_content'],
        input: [
          expect.objectContaining({ content: 'Follow the instructions', role: 'system' }),
          expect.objectContaining({ content: 'Hello', role: 'user' }),
        ],
        model: 'grok-4.6',
        prompt_cache_key: deriveConversationSessionId(CONVERSATION_KEY, FIRST_SEEN_MS),
        reasoning: { summary: 'auto' },
        store: false,
        stream: true,
      });
      expect(body).not.toHaveProperty('instructions');
      expect(body).not.toHaveProperty('safety_identifier');
      expect(body).not.toHaveProperty('user');
      expect(body).not.toHaveProperty('metadata');
    });

    it('keeps session headers stable and request identifiers fresh across requests', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({ error: { message: 'stub', type: 'invalid_request_error' } }),
            {
              headers: { 'Content-Type': 'application/json' },
              status: 400,
            },
          ),
      );
      const runtime = new LobeGrokAI({
        apiKey: jwtAccessToken,
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
        firstSeenMs: FIRST_SEEN_MS,
        installationId: INSTALLATION_ID,
      });
      const payload = {
        messages: [
          { content: 'one', role: 'user' },
          { content: 'two', role: 'user' },
        ],
        model: 'grok-4.6',
        stream: true,
      } as const;

      await expect(runtime.chat(payload as never)).rejects.toBeDefined();
      await expect(runtime.chat(payload as never)).rejects.toBeDefined();

      const firstHeaders = headerRecord(fetchImpl.mock.calls[0][0], fetchImpl.mock.calls[0][1]);
      const secondHeaders = headerRecord(fetchImpl.mock.calls[1][0], fetchImpl.mock.calls[1][1]);
      const expectedSessionId = deriveConversationSessionId(CONVERSATION_KEY, FIRST_SEEN_MS);

      expect(firstHeaders['x-grok-session-id']).toBe(expectedSessionId);
      expect(secondHeaders['x-grok-session-id']).toBe(expectedSessionId);
      expect(firstHeaders['x-grok-conv-id']).toBe(expectedSessionId);
      expect(secondHeaders['x-grok-conv-id']).toBe(expectedSessionId);
      expect(firstHeaders['x-grok-agent-id']).toBe(deriveGrokAgentId(INSTALLATION_ID));
      expect(secondHeaders['x-grok-agent-id']).toBe(deriveGrokAgentId(INSTALLATION_ID));
      expect(firstHeaders['x-grok-turn-idx']).toBe('2');
      expect(secondHeaders['x-grok-turn-idx']).toBe('2');
      expect(firstHeaders['x-grok-req-id']).not.toBe(secondHeaders['x-grok-req-id']);
      expect(firstHeaders['traceparent']).not.toBe(secondHeaders['traceparent']);

      expect(requestBody(fetchImpl.mock.calls[0][1]).prompt_cache_key).toBe(expectedSessionId);
      expect(requestBody(fetchImpl.mock.calls[1][1]).prompt_cache_key).toBe(expectedSessionId);
    });

    it('uses minimal Grok /v1/models headers without response-only identity headers', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ data: GROK_PROXY_MODELS.data, object: 'list' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          }),
      );
      const runtime = new LobeGrokAI({
        apiKey: jwtAccessToken,
        conversationKey: CONVERSATION_KEY,
        fetch: fetchImpl,
        firstSeenMs: FIRST_SEEN_MS,
        installationId: INSTALLATION_ID,
      });

      await runtime.models();

      expect(fetchImpl).toHaveBeenCalled();
      const [input, init] = fetchImpl.mock.calls[0];
      expect(requestUrl(input)).toContain('/models');
      const headers = headerRecord(input, init);
      expect(Object.keys(headers).sort()).toEqual(['accept', 'authorization', 'user-agent']);
      expect(headers['accept']).toBe('*/*');
      expect(headers['authorization']).toMatch(/^Bearer \S+$/);
      expect(headers['user-agent']).toBe(
        `grok-shell/${GROK_CLIENT_VERSION} (${GROK_DEFAULT_USER_AGENT_PLATFORM})`,
      );
      expect(headers).not.toHaveProperty('content-type');
      expect(headers).not.toHaveProperty('x-grok-client-identifier');
      expect(headers).not.toHaveProperty('x-grok-client-version');
      expect(headers).not.toHaveProperty('x-grok-agent-id');
      expect(headers).not.toHaveProperty('x-grok-session-id');
      expect(headers).not.toHaveProperty('x-grok-conv-id');
      expect(headers).not.toHaveProperty('x-grok-req-id');
      expect(headers).not.toHaveProperty('traceparent');
      expectNoStainlessHeaders(headers);
    });
  });
});
