// @vitest-environment node
import { type LobeRuntimeAI } from '@lobechat/model-runtime';
import { ModelRuntime } from '@lobechat/model-runtime';
import { ChatErrorType } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auth } from '@/auth';
import {
  MODERATION_HEADER_ACTION_DOWNGRADE,
  MODERATION_HEADERS,
} from '@/const/platform/contentModeration';
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { createModerationAwareRuntime } from '@/server/enterprise/services/contentModeration/runtime';
import {
  initModelRuntimeFromDB,
  resetModelRuntimeConversationRegistry,
} from '@/server/modules/ModelRuntime';
import { createTraceHeader } from '@/utils/trace';

import { POST } from './route';

vi.mock('@/app/(backend)/middleware/auth/utils', () => ({
  checkAuthMethod: vi.fn(),
}));

/**
 * The conversation identity is NOT mocked: R2 §L11 asked for a test that proves the
 * trace payload's topic id actually reaches the identity the runtime is built with, so
 * the real resolver runs here and only the database read underneath it is faked.
 */
vi.mock('@/server/modules/ModelRuntime', async () => {
  const conversationIdentity = await import('@/server/modules/ModelRuntime/conversationIdentity');

  return {
    ...conversationIdentity,
    createTraceOptions: vi.fn().mockReturnValue({}),
    initModelRuntimeFromDB: vi.fn(),
  };
});

const TOPIC_CREATED_AT = new Date('2026-08-18T02:15:00.000Z');
const { findById } = vi.hoisted(() => ({ findById: vi.fn() }));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({ findById })),
}));

vi.mock('@/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

// 模拟请求和响应
let request: Request;
beforeEach(() => {
  request = new Request(new URL('https://test.com'), {
    method: 'POST',
    body: JSON.stringify({ model: 'test-model' }),
  });

  // Default: valid session
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {} as any,
    user: { id: 'test-user-id' } as any,
  });

  resetModelRuntimeConversationRegistry();
  findById.mockReset();
  findById.mockResolvedValue({ createdAt: TOPIC_CREATED_AT, id: 'topic-42' });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST handler', () => {
  describe('init chat model', () => {
    it('should initialize ModelRuntime correctly with valid session', async () => {
      const mockParams = Promise.resolve({ provider: 'test-provider' });

      const mockChatResponse = new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(mockChatResponse),
      };

      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      await POST(request as unknown as Request, { params: mockParams });

      expect(initModelRuntimeFromDB).toHaveBeenCalledWith(
        expect.anything(),
        'test-user-id',
        'test-provider',
        undefined,
        { resolveConversation: expect.any(Function) },
      );
      // An ordinary provider never consumes the identity, so nothing was read.
      expect(findById).not.toHaveBeenCalled();
    });

    it('carries the trace payload topic id into the conversation key of a CLI runtime', async () => {
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(new Response('{}')),
      };
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      await POST(
        new Request(new URL('https://test.com'), {
          body: JSON.stringify({ model: 'grok-4.6' }),
          headers: createTraceHeader({ topicId: 'topic-42' }),
          method: 'POST',
        }),
        { params: Promise.resolve({ provider: 'grok' }) },
      );

      const [, , , , options] = vi.mocked(initModelRuntimeFromDB).mock.calls[0]!;
      // The seam only calls the thunk for a runtime that sends a conversation id.
      await expect(
        (options as { resolveConversation: () => Promise<unknown> }).resolveConversation(),
      ).resolves.toEqual({
        conversationKey: 'user:test-user-id:topic:topic-42',
        // The UUIDv7 session id is stamped with when the conversation really started.
        firstSeenMs: TOPIC_CREATED_AT.getTime(),
      });
      expect(findById).toHaveBeenCalledWith('topic-42');
    });

    it('derives the topic identity from the DB, and a pending one before the topic exists', async () => {
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(new Response('{}')),
      };
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      const send = async (topicId?: string) =>
        POST(
          new Request(new URL('https://test.com'), {
            body: JSON.stringify({ model: 'grok-4.6' }),
            headers: {
              ...createTraceHeader({ ...(topicId ? { topicId } : {}) }),
              'x-agent-id': 'agent-7',
            },
            method: 'POST',
          }),
          { params: Promise.resolve({ provider: 'grok' }) },
        );

      await send();
      await send('topic-42');

      const resolve = (call: number) =>
        (
          vi.mocked(initModelRuntimeFromDB).mock.calls[call]![4] as {
            resolveConversation: () => Promise<{ conversationKey: string; firstSeenMs: number }>;
          }
        ).resolveConversation();

      // Turn 1 has no topic yet: a pending, agent-scoped identity.
      await expect(resolve(0)).resolves.toEqual({
        conversationKey: 'user:test-user-id:agent:agent-7:pending',
        firstSeenMs: expect.any(Number),
      });
      // From the topic on, the identity is derived from durable data only.
      await expect(resolve(1)).resolves.toEqual({
        conversationKey: 'user:test-user-id:topic:topic-42',
        firstSeenMs: TOPIC_CREATED_AT.getTime(),
      });
    });

    it('should return Unauthorized error when no session exists', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      const mockParams = Promise.resolve({ provider: 'test-provider' });

      const response = await POST(request, { params: mockParams });

      expect(response.status).toBe(401);
    });
  });

  describe('chat', () => {
    it('should correctly handle chat completion with valid payload', async () => {
      const mockParams = Promise.resolve({ provider: 'test-provider' });
      const mockChatPayload = { message: 'Hello, world!' };
      request = new Request(new URL('https://test.com'), {
        method: 'POST',
        body: JSON.stringify(mockChatPayload),
      });

      const mockChatResponse: any = { success: true, message: 'Reply from agent' };
      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockResolvedValue(mockChatResponse),
      };

      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      const response = await POST(request as unknown as Request, { params: mockParams });

      expect(response).toEqual(mockChatResponse);
      expect(mockRuntime.chat).toHaveBeenCalledWith(mockChatPayload, {
        user: 'test-user-id',
        signal: expect.anything(),
      });
    });

    it('should return an error response when chat completion fails', async () => {
      const mockParams = Promise.resolve({ provider: 'test-provider' });
      const mockChatPayload = { message: 'Hello, world!' };
      request = new Request(new URL('https://test.com'), {
        method: 'POST',
        body: JSON.stringify(mockChatPayload),
      });

      const mockErrorResponse = {
        errorType: ChatErrorType.InternalServerError,
        error: { errorMessage: 'Something went wrong', errorType: 500 },
        errorMessage: 'Something went wrong',
      };

      const mockRuntime: LobeRuntimeAI = {
        baseURL: 'abc',
        chat: vi.fn().mockRejectedValue(mockErrorResponse),
      };

      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(new ModelRuntime(mockRuntime));

      const response = await POST(request, { params: mockParams });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        body: {
          errorMessage: 'Something went wrong',
          error: {
            errorMessage: 'Something went wrong',
            errorType: 500,
          },
          provider: 'test-provider',
        },
        errorType: 500,
      });
    });

    it('maps a wrapper block to HTTP 403 with the B2↔B5 body', async () => {
      const mockParams = Promise.resolve({ provider: 'test-provider' });
      request = new Request(new URL('https://test.com'), {
        body: JSON.stringify({
          messages: [{ content: 'bad prompt', role: 'user' }],
          model: 'gpt-4o',
        }),
        method: 'POST',
      });

      const innerChat = vi.fn();
      const wrapped = createModerationAwareRuntime(
        new ModelRuntime({ chat: innerChat } as never),
        { db: {} as never, provider: 'test-provider', userId: 'test-user-id' },
        {
          createRecordId: () => 'rec-blocked',
          evaluate: async () => ({
            effectiveAction: 'block',
            skipped: false,
            topCategory: 'sexual',
          }),
          extractPromptText: () => 'bad prompt',
          getSnapshot: async () => ({
            config: {
              messages: { blockMessage: 'Please revise.', showCategoryToUser: true },
              mode: 'enforce',
            },
          }),
          initRuntime: vi.fn(),
          record: vi.fn(),
        },
      );
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(wrapped);

      const response = await POST(request, { params: mockParams });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        body: {
          category: 'sexual',
          message: 'Please revise.',
          recordId: 'rec-blocked',
        },
        errorType: PLATFORM_ERROR_CODES.PLATFORM_CONTENT_MODERATION_BLOCKED,
      });
      expect(innerChat).not.toHaveBeenCalled();
    });

    it('returns a downgraded stream with x-lobe-moderation* headers', async () => {
      const mockParams = Promise.resolve({ provider: 'test-provider' });
      request = new Request(new URL('https://test.com'), {
        body: JSON.stringify({
          messages: [{ content: 'borderline', role: 'user' }],
          model: 'gpt-4o',
        }),
        method: 'POST',
      });

      const innerChat = vi
        .fn()
        .mockResolvedValue(
          new Response('stream', { headers: { 'content-type': 'text/event-stream' } }),
        );
      const wrapped = createModerationAwareRuntime(
        new ModelRuntime({ chat: innerChat } as never),
        { db: {} as never, provider: 'test-provider', userId: 'test-user-id' },
        {
          createRecordId: () => 'rec-down',
          evaluate: async () => ({
            downgradeTarget: { model: 'gpt-4o-mini', provider: 'test-provider' },
            effectiveAction: 'downgrade',
            skipped: false,
            topCategory: 'jailbreak',
          }),
          extractPromptText: () => 'borderline',
          getSnapshot: async () => ({
            config: {
              messages: { blockMessage: 'no', showCategoryToUser: true },
              mode: 'enforce',
            },
          }),
          initRuntime: vi.fn(),
          record: vi.fn(),
        },
      );
      vi.mocked(initModelRuntimeFromDB).mockResolvedValue(wrapped);

      const response = await POST(request, { params: mockParams });

      expect(response.status).toBe(200);
      expect(response.headers.get(MODERATION_HEADERS.ACTION)).toBe(
        MODERATION_HEADER_ACTION_DOWNGRADE,
      );
      expect(response.headers.get(MODERATION_HEADERS.PROVIDER)).toBe('test-provider');
      expect(response.headers.get(MODERATION_HEADERS.MODEL)).toBe('gpt-4o-mini');
      expect(response.headers.get(MODERATION_HEADERS.CATEGORY)).toBe('jailbreak');
      expect(response.headers.get(MODERATION_HEADERS.RECORD)).toBe('rec-down');
    });
  });
});
