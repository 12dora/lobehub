// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveCursorConversationId } from '../../browserProfile';
import { AgentRuntimeErrorType } from '../../types/error';
import {
  CURSOR_CONVERSATION_HEADER,
  CURSOR_TRANSPORT_ORIGIN,
  LobeCursorAI,
  toCursorKnownModelCard,
} from './index';

const encoder = new TextEncoder();

const sseBody = (events: object[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

const successTurn = () =>
  new Response(
    sseBody([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'pong',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      },
    ]),
    {
      headers: { 'Content-Type': 'text/event-stream' },
      status: 200,
    },
  );

const TOOL_BLOCK = `<aihub:tool_calls>\n${JSON.stringify([{ name: 'search', arguments: { q: 'pong' } }])}\n</aihub:tool_calls>`;

const SEARCH_TOOL = {
  function: {
    description: 'Search docs',
    name: 'search',
    parameters: { properties: { q: { type: 'string' } }, type: 'object' },
  },
  type: 'function' as const,
};

const markerTurn = () =>
  new Response(
    sseBody([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: TOOL_BLOCK }] },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: TOOL_BLOCK,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      },
    ]),
    {
      headers: { 'Content-Type': 'text/event-stream' },
      status: 200,
    },
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LobeCursorAI', () => {
  describe('chat', () => {
    it('POSTs /v1/turn with the bearer token, SSE accept, and the mapped turn body', async () => {
      const fetchImpl = vi.fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >(async () => successTurn());
      const runtime = new LobeCursorAI({ apiKey: 'jwt-token', fetch: fetchImpl });

      const response = await runtime.chat({
        messages: [
          { content: 'be terse', role: 'system' },
          { content: 'hello', role: 'user' },
          { content: 'hi', role: 'assistant' },
          { content: 'Reply with pong', role: 'user' },
        ],
        model: 'composer-2.5',
        stream: true,
        temperature: 0.2,
      });

      expect(response).toBeInstanceOf(Response);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe(`${CURSOR_TRANSPORT_ORIGIN}/v1/turn`);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        'Accept': 'text/event-stream',
        'Authorization': 'Bearer jwt-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        history: {
          messages: [
            { user: { content: [{ text: { text: '<system>be terse</system>\n\nhello' } }] } },
            { assistant: { content: [{ text: { text: 'hi' } }] } },
          ],
          replaceUserInfo: false,
        },
        model: 'composer-2.5',
        prompt: 'Reply with pong',
      });

      const sse = await response.text();
      expect(sse).toContain('event: text');
      expect(sse).toContain('pong');
      expect(sse).toContain('event: stop');
    });

    it('forwards tools into the turn body as a system tool-protocol block', async () => {
      const fetchImpl = vi.fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >(async () => successTurn());
      const runtime = new LobeCursorAI({ apiKey: 'jwt-token', fetch: fetchImpl });

      await runtime.chat({
        messages: [{ content: 'search docs', role: 'user' }],
        model: 'composer-2.5',
        tools: [
          {
            function: {
              description: 'Search docs',
              name: 'search',
              parameters: { properties: { q: { type: 'string' } }, type: 'object' },
            },
            type: 'function',
          },
        ],
      });

      const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
      expect(body.prompt).toContain('<aihub:tool_calls>');
      expect(body.prompt).toContain('"name":"search"');
      expect(body.prompt).toContain('search docs');
    });

    it('forwards payload tools into the turn system prefix', async () => {
      const fetchImpl = vi.fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >(async () => successTurn());
      const runtime = new LobeCursorAI({ apiKey: 'jwt', fetch: fetchImpl });

      await runtime.chat({
        messages: [{ content: 'search pong', role: 'user' }],
        model: 'composer-2.5',
        tools: [
          {
            function: {
              description: 'Search docs',
              name: 'search',
              parameters: { properties: { q: { type: 'string' } }, type: 'object' },
            },
            type: 'function',
          },
        ],
      });

      const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
      expect(body.prompt).toContain('<aihub:tool_calls>');
      expect(body.prompt).toContain('"name":"search"');
      expect(body.prompt).toContain('search pong');
    });

    it('parses a marker in the stream only when tools are active', async () => {
      const fetchImpl = vi.fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >(async () => markerTurn());
      const runtime = new LobeCursorAI({ apiKey: 'jwt', fetch: fetchImpl });

      const withTools = await runtime.chat({
        messages: [{ content: 'search', role: 'user' }],
        model: 'composer-2.5',
        tools: [SEARCH_TOOL],
      });
      const withToolsSse = await withTools.text();
      expect(withToolsSse).toContain('event: tool_calls');
      expect(withToolsSse).toContain('event: stop\ndata: "tool_calls"');
      expect(withToolsSse).not.toContain('aihub:tool_calls');
    });

    it('passes a marker-literal through when the chat has no tools', async () => {
      const fetchImpl = vi.fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >(async () => markerTurn());
      const runtime = new LobeCursorAI({ apiKey: 'jwt', fetch: fetchImpl });

      const response = await runtime.chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'composer-2.5',
      });
      const sse = await response.text();
      expect(sse).not.toContain('event: tool_calls');
      expect(sse).toContain('aihub:tool_calls');
      expect(sse).toContain('event: stop\ndata: "stop"');
    });

    it('passes a marker-literal through when tool_choice is none', async () => {
      const fetchImpl = vi.fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >(async () => markerTurn());
      const runtime = new LobeCursorAI({ apiKey: 'jwt', fetch: fetchImpl });

      const response = await runtime.chat({
        messages: [{ content: 'hi', role: 'user' }],
        model: 'composer-2.5',
        tool_choice: 'none',
        tools: [SEARCH_TOOL],
      });
      const sse = await response.text();
      const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
      expect(body.prompt).not.toContain('<aihub:tool_calls>');
      expect(sse).not.toContain('event: tool_calls');
      expect(sse).toContain('aihub:tool_calls');
    });

    it('sends one stable conversation id for every turn of the same conversation', async () => {
      const fetchImpl = vi.fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >(async () => successTurn());
      const installationId = '123e4567-e89b-42d3-a456-426614174000';
      const runtime = new LobeCursorAI({
        apiKey: 'jwt',
        conversationKey: 'user:u1:topic:t1',
        fetch: fetchImpl,
        installationId,
      });

      for (const prompt of ['first', 'second']) {
        const response = await runtime.chat({
          messages: [{ content: prompt, role: 'user' }],
          model: 'composer-2.5',
        });
        await response.text();
      }

      const expected = deriveCursorConversationId(installationId, 'user:u1:topic:t1');
      expect(expected).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
      for (const call of fetchImpl.mock.calls) {
        expect(call[1]?.headers).toMatchObject({ [CURSOR_CONVERSATION_HEADER]: expected });
      }
    });

    it('gives another conversation, and another installation, another id', async () => {
      const installationA = '123e4567-e89b-42d3-a456-426614174000';
      const installationB = '123e4567-e89b-42d3-a456-426614174001';
      const idOf = (installationId: string, conversationKey: string) =>
        deriveCursorConversationId(installationId, conversationKey);

      expect(idOf(installationA, 'topic-1')).not.toBe(idOf(installationA, 'topic-2'));
      expect(idOf(installationA, 'topic-1')).not.toBe(idOf(installationB, 'topic-1'));
    });

    it('omits the conversation header when either half is missing or malformed', async () => {
      const fetchImpl = vi.fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >(async () => successTurn());
      const cases = [
        { conversationKey: 'topic-1' },
        { installationId: '123e4567-e89b-42d3-a456-426614174000' },
        { conversationKey: 'topic-1', installationId: 'not-a-uuid' },
      ];

      for (const params of cases) {
        const runtime = new LobeCursorAI({ apiKey: 'jwt', fetch: fetchImpl, ...params });
        const response = await runtime.chat({
          messages: [{ content: 'hi', role: 'user' }],
          model: 'composer-2.5',
        });
        await response.text();
      }

      for (const call of fetchImpl.mock.calls) {
        expect(call[1]?.headers).not.toHaveProperty(CURSOR_CONVERSATION_HEADER);
      }
    });

    it('forwards the abort signal', async () => {
      const fetchImpl = vi.fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >(async () => successTurn());
      const runtime = new LobeCursorAI({ apiKey: 'jwt', fetch: fetchImpl });
      const signal = AbortSignal.abort();

      await runtime.chat(
        { messages: [{ content: 'hi', role: 'user' }], model: 'composer-2.5' },
        { signal },
      );

      expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ signal });
    });

    it('maps 401 unauthorized to OAuthAuthorizationExpired', async () => {
      const fetchImpl = vi.fn<
        (input: string | URL | Request, init?: RequestInit) => Promise<Response>
      >(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'unauthorized', message: 'not logged in' } }),
            {
              status: 401,
            },
          ),
      );
      const runtime = new LobeCursorAI({ apiKey: 'expired', fetch: fetchImpl });

      await expect(
        runtime.chat({ messages: [{ content: 'hi', role: 'user' }], model: 'composer-2.5' }),
      ).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.OAuthAuthorizationExpired,
        message: 'not logged in',
        provider: 'cursor',
      });
    });

    it('maps 503 cli_unavailable to ProviderBizError', async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'cli_unavailable', message: 'cursor-agent missing' } }),
            { status: 503 },
          ),
      );
      const runtime = new LobeCursorAI({ apiKey: 'jwt', fetch: fetchImpl });

      await expect(
        runtime.chat({ messages: [{ content: 'hi', role: 'user' }], model: 'composer-2.5' }),
      ).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.ProviderBizError,
        message: 'cursor-agent missing',
      });
    });

    it('surfaces a missing transport as ProviderBizError', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      const runtime = new LobeCursorAI({ apiKey: 'jwt', fetch: fetchImpl });

      await expect(
        runtime.chat({ messages: [{ content: 'hi', role: 'user' }], model: 'composer-2.5' }),
      ).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.ProviderBizError,
        message: 'Cursor Agent transport unavailable',
      });
    });
  });

  describe('models', () => {
    it('GETs /v1/models and merges curated catalog abilities; unknown ids stay uninferred', async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                { id: 'auto', name: 'Auto' },
                { id: 'composer-2.5', name: 'Composer 2.5' },
                { id: 'claude-opus-5-thinking-high', name: 'Claude Opus 5 1M Thinking' },
                { id: 'gpt-5.6-sol-high', name: 'GPT-5.6 Sol 1M High' },
                { id: 'brand-new-cursor-model', name: 'Brand New 1M' },
              ],
            }),
            { status: 200 },
          ),
      );
      const runtime = new LobeCursorAI({ apiKey: 'jwt', fetch: fetchImpl });
      const cards = await runtime.models();

      expect(fetchImpl).toHaveBeenCalledWith(
        `${CURSOR_TRANSPORT_ORIGIN}/v1/models`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'application/json',
            Authorization: 'Bearer jwt',
          }),
          method: 'GET',
        }),
      );

      expect(cards).toEqual([
        {
          abilities: { functionCall: true, reasoning: false, vision: false },
          contextWindowTokens: 200_000,
          // Follows the curated card in model-bank (renamed by the frontend round).
          displayName: 'Auto (Cursor)',
          enabled: false,
          functionCall: true,
          id: 'auto',
          reasoning: false,
          settings: undefined,
          type: 'chat',
          vision: false,
        },
        {
          abilities: { functionCall: true, reasoning: false, vision: true },
          contextWindowTokens: 200_000,
          displayName: 'Composer 2.5',
          enabled: false,
          functionCall: true,
          id: 'composer-2.5',
          reasoning: false,
          settings: undefined,
          type: 'chat',
          vision: true,
        },
        {
          abilities: { functionCall: true, reasoning: true, vision: true },
          contextWindowTokens: 1_000_000,
          displayName: 'Claude Opus 5 1M Thinking',
          enabled: false,
          functionCall: true,
          id: 'claude-opus-5-thinking-high',
          reasoning: true,
          settings: undefined,
          type: 'chat',
          vision: true,
        },
        {
          abilities: { functionCall: true, reasoning: true, vision: true },
          contextWindowTokens: 1_000_000,
          displayName: 'GPT-5.6 Sol 1M High',
          enabled: false,
          functionCall: true,
          id: 'gpt-5.6-sol-high',
          reasoning: true,
          settings: undefined,
          type: 'chat',
          vision: true,
        },
        {
          abilities: undefined,
          contextWindowTokens: 1_000_000,
          displayName: 'Brand New 1M',
          enabled: false,
          id: 'brand-new-cursor-model',
          reasoning: undefined,
          type: 'chat',
        },
      ]);
    });

    it('shallow-clones known settings so callers cannot mutate later cards', () => {
      const known = {
        abilities: { functionCall: true, reasoning: false, vision: false },
        contextWindowTokens: 200_000,
        displayName: 'Auto (Cursor)',
        enabled: true,
        family: 'cursor',
        id: 'auto',
        releasedAt: '2026-08-11',
        settings: { extendParams: ['enableReasoning'] as ['enableReasoning'] },
        type: 'chat' as const,
      };
      const first = toCursorKnownModelCard('auto', 'Auto', known);
      const second = toCursorKnownModelCard('auto', 'Auto', known);

      expect(first.settings).toEqual({ extendParams: ['enableReasoning'] });
      expect(first.settings).not.toBe(known.settings);
      expect(first.settings).not.toBe(second.settings);
      if (first.settings) first.settings.extendParams = ['effort'];
      expect(second.settings).toEqual({ extendParams: ['enableReasoning'] });
      expect(known.settings).toEqual({ extendParams: ['enableReasoning'] });
    });

    it('maps a 401 on /v1/models to OAuthAuthorizationExpired', async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'unauthorized', message: 'token expired' } }),
            {
              status: 401,
            },
          ),
      );
      const runtime = new LobeCursorAI({ apiKey: 'jwt', fetch: fetchImpl });

      await expect(runtime.models()).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.OAuthAuthorizationExpired,
        message: 'token expired',
      });
    });

    it('maps a 503 on /v1/models to ProviderBizError', async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'cli_unavailable', message: 'no binary' } }),
            {
              status: 503,
            },
          ),
      );
      const runtime = new LobeCursorAI({ apiKey: 'jwt', fetch: fetchImpl });

      await expect(runtime.models()).rejects.toMatchObject({
        errorType: AgentRuntimeErrorType.ProviderBizError,
        message: 'no binary',
      });
    });
  });
});
