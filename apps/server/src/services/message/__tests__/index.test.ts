import { type LobeChatDatabase } from '@lobechat/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageModel } from '@/database/models/message';
import { TopicModel } from '@/database/models/topic';
import { FileService } from '@/server/services/file';

import { MessageService } from '../index';

const mockApplyTopicApprovalSnapshot = vi.hoisted(() =>
  vi.fn(
    async ({
      metadata,
      workspaceId,
    }: {
      metadata?: { approvalMode?: string };
      workspaceId?: string | null;
    }) => {
      const { approvalMode, ...rest } = metadata ?? {};
      if (workspaceId) return Object.keys(rest).length > 0 ? rest : undefined;
      return { ...rest, approvalMode: approvalMode ?? 'manual' };
    },
  ),
);

vi.mock('@/database/models/message');
vi.mock('@/database/models/topic');
vi.mock('@/server/services/file');
vi.mock('@/server/services/topicApproval', () => ({
  applyTopicApprovalSnapshot: mockApplyTopicApprovalSnapshot,
}));

describe('MessageService', () => {
  let messageService: MessageService;
  let mockDB: LobeChatDatabase;
  let mockMessageModel: MessageModel;
  let mockTopicModel: { create: ReturnType<typeof vi.fn> };
  let mockFileService: FileService;
  const userId = 'test-user-id';

  beforeEach(() => {
    mockDB = {} as LobeChatDatabase;
    mockMessageModel = {
      create: vi.fn(),
      deleteMessage: vi.fn(),
      deleteMessages: vi.fn(),
      query: vi.fn(),
      update: vi.fn(),
      updateMessagePlugin: vi.fn(),
      updateMessageRAG: vi.fn(),
      updateMetadata: vi.fn(),
      updatePluginState: vi.fn(),
      updateToolMessage: vi.fn(),
    } as any;
    mockTopicModel = {
      create: vi.fn().mockResolvedValue({ id: 'topic-new' }),
    };

    mockFileService = {
      getFullFileUrl: vi.fn().mockImplementation((path) => Promise.resolve(`/files${path}`)),
    } as any;

    // Mock constructors
    vi.mocked(MessageModel).mockImplementation(() => mockMessageModel);
    vi.mocked(TopicModel).mockImplementation(() => mockTopicModel as any);
    vi.mocked(FileService).mockImplementation(() => mockFileService);
    mockApplyTopicApprovalSnapshot.mockClear();
    mockApplyTopicApprovalSnapshot.mockImplementation(
      async ({
        metadata,
        workspaceId,
      }: {
        metadata?: { approvalMode?: string };
        workspaceId?: string | null;
      }) => {
        const { approvalMode, ...rest } = metadata ?? {};
        if (workspaceId) return Object.keys(rest).length > 0 ? rest : undefined;
        return { ...rest, approvalMode: approvalMode ?? 'manual' };
      },
    );

    messageService = new MessageService(mockDB, userId);
  });

  describe('removeMessage', () => {
    it('should delete message and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';

      const result = await messageService.removeMessage(messageId);

      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith(messageId);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should delete message and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const mockMessages = [{ id: 'msg-2', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.removeMessage(messageId, { sessionId: 'session-1' });

      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith(messageId);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId: undefined, sessionId: 'session-1', topicId: undefined },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('should delete message and return message list when topicId provided', async () => {
      const messageId = 'msg-1';
      const mockMessages = [{ id: 'msg-2', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.removeMessage(messageId, { topicId: 'topic-1' });

      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith(messageId);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId: undefined, sessionId: undefined, topicId: 'topic-1' },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('removeMessages', () => {
    it('should delete messages and return { success: true } when no sessionId/topicId provided', async () => {
      const messageIds = ['msg-1', 'msg-2'];

      const result = await messageService.removeMessages(messageIds);

      expect(mockMessageModel.deleteMessages).toHaveBeenCalledWith(messageIds);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should delete messages and return message list when sessionId provided', async () => {
      const messageIds = ['msg-1', 'msg-2'];
      const mockMessages = [{ id: 'msg-3', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.removeMessages(messageIds, { sessionId: 'session-1' });

      expect(mockMessageModel.deleteMessages).toHaveBeenCalledWith(messageIds);
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('updateMessageRAG', () => {
    it('should update RAG and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';
      const ragValue = { fileChunks: [{ id: 'chunk-1', similarity: 0.95 }] };

      const result = await messageService.updateMessageRAG(messageId, ragValue);

      expect(mockMessageModel.updateMessageRAG).toHaveBeenCalledWith(messageId, ragValue);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should update RAG and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const ragValue = { fileChunks: [{ id: 'chunk-1', similarity: 0.95 }] };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMessageRAG(messageId, ragValue, {
        sessionId: 'session-1',
      });

      expect(mockMessageModel.updateMessageRAG).toHaveBeenCalledWith(messageId, ragValue);
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('updatePluginError', () => {
    it('should update plugin error and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';
      const error = { type: 'TestError', message: 'Test error message' };

      const result = await messageService.updatePluginError(messageId, error);

      expect(mockMessageModel.updateMessagePlugin).toHaveBeenCalledWith(messageId, { error });
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should update plugin error and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const error = { type: 'TestError', message: 'Test error message' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updatePluginError(messageId, error, {
        sessionId: 'session-1',
      });

      expect(mockMessageModel.updateMessagePlugin).toHaveBeenCalledWith(messageId, { error });
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('updatePluginState', () => {
    it('should update plugin state and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';
      const state = { key: 'value' };

      const result = await messageService.updatePluginState(messageId, state, {});

      expect(mockMessageModel.updatePluginState).toHaveBeenCalledWith(messageId, state);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should update plugin state and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const state = { key: 'value' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updatePluginState(messageId, state, {
        sessionId: 'session-1',
      });

      expect(mockMessageModel.updatePluginState).toHaveBeenCalledWith(messageId, state);
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('updateMessage', () => {
    it('should update message and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';
      const value = { content: 'updated content' };

      const result = await messageService.updateMessage(messageId, value as any, {});

      expect(mockMessageModel.update).toHaveBeenCalledWith(messageId, value);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should update message and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const value = { content: 'updated content' };
      const mockMessages = [{ id: 'msg-1', content: 'updated content' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMessage(messageId, value as any, {
        sessionId: 'session-1',
      });

      expect(mockMessageModel.update).toHaveBeenCalledWith(messageId, value);
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('batchMutate', () => {
    it('quietly applies create/update/tool updates without querying messages', async () => {
      vi.mocked(mockMessageModel.create).mockResolvedValue({ id: 'msg-created' } as any);
      vi.mocked(mockMessageModel.update).mockResolvedValue({ success: true } as any);
      vi.mocked(mockMessageModel.updateToolMessage).mockResolvedValue({ success: true } as any);

      const result = await messageService.batchMutate([
        {
          message: { content: '', id: 'msg-created', role: 'assistant', topicId: 'topic-1' } as any,
          type: 'createMessage',
        },
        {
          id: 'msg-created',
          type: 'updateMessage',
          value: { content: 'hello' } as any,
        },
        {
          id: 'tool-1',
          type: 'updateToolMessage',
          value: { content: 'tool result' },
        },
      ]);

      expect(mockMessageModel.create).toHaveBeenCalledWith(
        { content: '', id: 'msg-created', role: 'assistant', topicId: 'topic-1' },
        'msg-created',
      );
      expect(mockMessageModel.update).toHaveBeenCalledWith('msg-created', { content: 'hello' });
      expect(mockMessageModel.updateToolMessage).toHaveBeenCalledWith('tool-1', {
        content: 'tool result',
      });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
      expect(result).toEqual({
        results: [
          { id: 'msg-created', index: 0, success: true, type: 'createMessage' },
          { id: 'msg-created', index: 1, success: true, type: 'updateMessage' },
          { id: 'tool-1', index: 2, success: true, type: 'updateToolMessage' },
        ],
        success: true,
      });
    });

    it('returns per-operation failures without throwing away later operations', async () => {
      vi.mocked(mockMessageModel.create).mockRejectedValueOnce(new Error('create failed'));
      vi.mocked(mockMessageModel.update).mockResolvedValue({ success: true } as any);

      const result = await messageService.batchMutate([
        {
          message: { content: '', id: 'missing-assistant', role: 'assistant' } as any,
          type: 'createMessage',
        },
        {
          id: 'still-runs',
          type: 'updateMessage',
          value: { content: 'still runs' } as any,
        },
      ]);

      expect(mockMessageModel.update).toHaveBeenCalledWith('still-runs', {
        content: 'still runs',
      });
      expect(result).toEqual({
        results: [
          { id: 'missing-assistant', index: 0, success: false, type: 'createMessage' },
          { id: 'still-runs', index: 1, success: true, type: 'updateMessage' },
        ],
        success: false,
      });
    });
  });

  describe('updateMetadata', () => {
    it('should update metadata and return { success: true } when no sessionId/topicId provided', async () => {
      const messageId = 'msg-1';
      const metadata = { someKey: 'someValue', count: 42 };

      const result = await messageService.updateMetadata(messageId, metadata);

      expect(mockMessageModel.updateMetadata).toHaveBeenCalledWith(messageId, metadata);
      expect(result).toEqual({ success: true });
      expect(mockMessageModel.query).not.toHaveBeenCalled();
    });

    it('should update metadata and return message list when sessionId provided', async () => {
      const messageId = 'msg-1';
      const metadata = { someKey: 'someValue', count: 42 };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMetadata(messageId, metadata, {
        sessionId: 'session-1',
      });

      expect(mockMessageModel.updateMetadata).toHaveBeenCalledWith(messageId, metadata);
      expect(mockMessageModel.query).toHaveBeenCalled();
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('should update metadata and return message list when topicId provided', async () => {
      const messageId = 'msg-1';
      const metadata = { key: 'value' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMetadata(messageId, metadata, {
        topicId: 'topic-1',
      });

      expect(mockMessageModel.updateMetadata).toHaveBeenCalledWith(messageId, metadata);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId: undefined, sessionId: undefined, topicId: 'topic-1' },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('createMessage', () => {
    it('should create message and return message list', async () => {
      const params = {
        agentId: 'agent-1',
        content: 'Hello',
        role: 'user' as const,
      };
      const createdMessage = { id: 'msg-1', ...params };
      const mockMessages = [createdMessage, { id: 'msg-2', content: 'Hi' }];

      vi.mocked(mockMessageModel.create).mockResolvedValue(createdMessage as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.createMessage(params as any);

      expect(mockMessageModel.create).toHaveBeenCalledWith(
        expect.objectContaining(params),
        undefined,
      );
      expect(mockTopicModel.create).not.toHaveBeenCalled();
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        {
          agentId: 'agent-1',
          current: 0,
          groupId: undefined,
          pageSize: 9999,
          threadId: undefined,
          topicId: undefined,
        },
        expect.objectContaining({
          postProcessUrl: expect.any(Function),
        }),
      );
      expect(result).toEqual({
        id: 'msg-1',
        messages: mockMessages,
      });
    });

    it('creates a topic with client-supplied approvalMode and attaches the message', async () => {
      const createdMessage = { id: 'msg-1', content: 'Hello', topicId: 'topic-new' };
      vi.mocked(mockMessageModel.create).mockResolvedValue(createdMessage as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue([createdMessage] as any);

      const result = await messageService.createMessage({
        agentId: 'agent-1',
        content: 'Hello',
        newTopic: {
          metadata: { approvalMode: 'auto-run' },
          title: 'First send',
          topicMessageIds: ['old-1'],
        },
        role: 'user',
      } as any);

      expect(mockApplyTopicApprovalSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { approvalMode: 'auto-run' },
          userId,
        }),
      );
      expect(mockTopicModel.create).toHaveBeenCalledWith({
        agentId: 'agent-1',
        groupId: undefined,
        messages: ['old-1'],
        metadata: { approvalMode: 'auto-run' },
        sessionId: undefined,
        title: 'First send',
      });
      expect(mockMessageModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ topicId: 'topic-new' }),
        undefined,
      );
      expect(mockMessageModel.create.mock.calls[0][0]).not.toHaveProperty('newTopic');
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        expect.objectContaining({ topicId: 'topic-new' }),
        expect.anything(),
      );
      expect(result.id).toBe('msg-1');
    });

    it('snapshots built-in manual when newTopic omits approvalMode', async () => {
      const createdMessage = { id: 'msg-1', content: 'Hello', topicId: 'topic-new' };
      vi.mocked(mockMessageModel.create).mockResolvedValue(createdMessage as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue([createdMessage] as any);

      await messageService.createMessage({
        agentId: 'agent-1',
        content: 'Hello',
        newTopic: { title: 'First send', topicMessageIds: [] },
        role: 'user',
      } as any);

      expect(mockApplyTopicApprovalSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: undefined, userId }),
      );
      expect(mockTopicModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { approvalMode: 'manual' },
          title: 'First send',
        }),
      );
    });

    it('does not create a topic when topicId is already provided', async () => {
      const createdMessage = { id: 'msg-1', content: 'Hello', topicId: 'topic-1' };
      vi.mocked(mockMessageModel.create).mockResolvedValue(createdMessage as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue([createdMessage] as any);

      await messageService.createMessage({
        agentId: 'agent-1',
        content: 'Hello',
        newTopic: { title: 'Ignored' },
        role: 'user',
        topicId: 'topic-1',
      } as any);

      expect(mockTopicModel.create).not.toHaveBeenCalled();
      expect(mockApplyTopicApprovalSnapshot).not.toHaveBeenCalled();
    });

    it('strips client approvalMode when creating a workspace topic', async () => {
      messageService = new MessageService(mockDB, userId, 'ws-1');
      const createdMessage = { id: 'msg-1', content: 'Hello', topicId: 'topic-new' };
      vi.mocked(mockMessageModel.create).mockResolvedValue(createdMessage as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue([createdMessage] as any);

      await messageService.createMessage({
        agentId: 'agent-1',
        content: 'Hello',
        newTopic: {
          metadata: { approvalMode: 'auto-run', workingDirectory: '/tmp' },
          title: 'Workspace first send',
        },
        role: 'user',
      } as any);

      expect(mockApplyTopicApprovalSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: 'ws-1' }),
      );
      expect(mockTopicModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { workingDirectory: '/tmp' },
        }),
      );
      expect(mockTopicModel.create.mock.calls[0][0].metadata).not.toHaveProperty('approvalMode');
    });

    it('should create message with topicId and groupId', async () => {
      const params = {
        agentId: 'agent-1',
        content: 'Hello',
        groupId: 'group-1',
        role: 'user' as const,
        topicId: 'topic-1',
      };
      const createdMessage = { id: 'msg-1', ...params };
      const mockMessages = [createdMessage];

      vi.mocked(mockMessageModel.create).mockResolvedValue(createdMessage as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.createMessage(params as any);

      expect(mockMessageModel.query).toHaveBeenCalledWith(
        {
          agentId: 'agent-1',
          current: 0,
          groupId: 'group-1',
          pageSize: 9999,
          threadId: undefined,
          topicId: 'topic-1',
        },
        expect.objectContaining({
          postProcessUrl: expect.any(Function),
        }),
      );
      expect(result.id).toBe('msg-1');
      expect(result.messages).toEqual(mockMessages);
    });

    it('should create message with threadId and query thread messages', async () => {
      const params = {
        agentId: 'agent-1',
        content: 'Hello in thread',
        groupId: 'group-1',
        role: 'user' as const,
        threadId: 'thread-1',
        topicId: 'topic-1',
      };
      const createdMessage = { id: 'msg-1', ...params };
      const mockMessages = [createdMessage];

      vi.mocked(mockMessageModel.create).mockResolvedValue(createdMessage as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.createMessage(params as any);

      expect(mockMessageModel.create).toHaveBeenCalledWith(params, undefined);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        {
          agentId: 'agent-1',
          current: 0,
          groupId: 'group-1',
          pageSize: 9999,
          threadId: 'thread-1',
          topicId: 'topic-1',
        },
        expect.objectContaining({
          postProcessUrl: expect.any(Function),
        }),
      );
      expect(result.id).toBe('msg-1');
      expect(result.messages).toEqual(mockMessages);
    });
  });

  describe('groupId context support', () => {
    const groupId = 'group-123';
    const topicId = 'topic-456';

    it('removeMessage should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const mockMessages = [{ id: 'msg-2', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.removeMessage(messageId, { groupId, topicId });

      expect(mockMessageModel.deleteMessage).toHaveBeenCalledWith(messageId);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('removeMessages should query with groupId when provided', async () => {
      const messageIds = ['msg-1', 'msg-2'];
      const mockMessages = [{ id: 'msg-3', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.removeMessages(messageIds, { groupId, topicId });

      expect(mockMessageModel.deleteMessages).toHaveBeenCalledWith(messageIds);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('updateMessage should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const value = { content: 'updated content' };
      const mockMessages = [{ id: 'msg-1', content: 'updated content' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMessage(messageId, value as any, {
        groupId,
        topicId,
      });

      expect(mockMessageModel.update).toHaveBeenCalledWith(messageId, value);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('updateMetadata should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const metadata = { key: 'value' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMetadata(messageId, metadata, {
        groupId,
        topicId,
      });

      expect(mockMessageModel.updateMetadata).toHaveBeenCalledWith(messageId, metadata);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('updatePluginState should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const state = { key: 'value' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updatePluginState(messageId, state, {
        groupId,
        topicId,
      });

      expect(mockMessageModel.updatePluginState).toHaveBeenCalledWith(messageId, state);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('updatePluginError should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const error = { type: 'TestError', message: 'Test error message' };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updatePluginError(messageId, error, {
        groupId,
        topicId,
      });

      expect(mockMessageModel.updateMessagePlugin).toHaveBeenCalledWith(messageId, { error });
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });

    it('updateMessageRAG should query with groupId when provided', async () => {
      const messageId = 'msg-1';
      const ragValue = { fileChunks: [{ id: 'chunk-1', similarity: 0.95 }] };
      const mockMessages = [{ id: 'msg-1', content: 'test' }];
      vi.mocked(mockMessageModel.query).mockResolvedValue(mockMessages as any);

      const result = await messageService.updateMessageRAG(messageId, ragValue, {
        groupId,
        topicId,
      });

      expect(mockMessageModel.updateMessageRAG).toHaveBeenCalledWith(messageId, ragValue);
      expect(mockMessageModel.query).toHaveBeenCalledWith(
        { groupId, sessionId: undefined, topicId },
        expect.objectContaining({
          groupAssistantMessages: false,
        }),
      );
      expect(result).toEqual({ messages: mockMessages, success: true });
    });
  });

  describe('RR5-1 — strips server-owned intervention provenance from client input', () => {
    const forgedProvenance = {
      assistantMessageId: 'asst-forged',
      fingerprint: 'f'.repeat(64),
      kind: 'approval' as const,
      messageId: 'm-1',
      operationId: 'op-forged',
      toolCallId: 'call-forged',
    };

    it('createMessage drops pluginIntervention kind/provenance but keeps status', async () => {
      vi.mocked(mockMessageModel.create).mockResolvedValue({ id: 'm-1' } as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue([] as any);

      await messageService.createMessage({
        content: '',
        pluginIntervention: {
          kind: 'approval',
          provenance: forgedProvenance,
          status: 'pending',
        },
        role: 'tool',
      } as any);

      const [passed] = vi.mocked(mockMessageModel.create).mock.calls[0];
      expect((passed as any).pluginIntervention).toEqual({ status: 'pending' });
      expect((passed as any).pluginIntervention.kind).toBeUndefined();
      expect((passed as any).pluginIntervention.provenance).toBeUndefined();
    });

    it('updateMessagePlugin drops intervention.kind but keeps the rest', async () => {
      vi.mocked(mockMessageModel.query).mockResolvedValue([] as any);

      await messageService.updateMessagePlugin(
        'm-1',
        {
          intervention: {
            kind: 'toolResult',
            provenance: forgedProvenance,
            status: 'approved',
          },
        },
        {},
      );

      expect(mockMessageModel.updateMessagePlugin).toHaveBeenCalledWith('m-1', {
        intervention: { status: 'approved' },
      });
    });

    it('batchMutate createMessage drops pluginIntervention kind/provenance', async () => {
      vi.mocked(mockMessageModel.create).mockResolvedValue({ id: 'm-1' } as any);

      await messageService.batchMutate([
        {
          message: {
            content: '',
            id: 'm-1',
            pluginIntervention: {
              kind: 'approval',
              provenance: forgedProvenance,
              status: 'pending',
            },
            role: 'tool',
          } as any,
          type: 'createMessage',
        },
      ]);

      const [passed] = vi.mocked(mockMessageModel.create).mock.calls[0];
      expect((passed as any).pluginIntervention).toEqual({ status: 'pending' });
    });

    it('leaves an ordinary message (no pluginIntervention) untouched', async () => {
      vi.mocked(mockMessageModel.create).mockResolvedValue({ id: 'm-1' } as any);
      vi.mocked(mockMessageModel.query).mockResolvedValue([] as any);

      await messageService.createMessage({ content: 'hi', role: 'user' } as any);

      const [passed] = vi.mocked(mockMessageModel.create).mock.calls[0];
      expect((passed as any).pluginIntervention).toBeUndefined();
    });
  });
});
