import type { AgentStreamEvent } from '@lobechat/agent-gateway-client';
import type { ConversationContext } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import type { ChatStore } from '@/store/chat/store';
import { messageMapKey } from '@/store/chat/utils/messageMapKey';

import { createGatewayMemberStreamHandler } from './gatewayMemberStreamHandler';

const context = {
  agentId: 'member-agent',
  groupId: 'group-1',
  scope: 'group',
  topicId: 'topic-1',
} as ConversationContext;

const bucketKey = messageMapKey({
  agentId: context.agentId ?? '',
  groupId: context.groupId,
  scope: context.scope,
  threadId: context.threadId,
  topicId: context.topicId,
});

const makeEvent = (type: AgentStreamEvent['type'], data?: AgentStreamEvent['data']) =>
  ({
    data,
    id: 'event-1',
    operationId: 'server-member-op',
    stepIndex: 0,
    timestamp: 0,
    type,
  }) as AgentStreamEvent;

const createStore = (dbMessagesMap: Record<string, any[]> = {}) =>
  ({
    associateMessageWithOperation: vi.fn(),
    completeOperation: vi.fn(),
    dbMessagesMap,
    internal_dispatchMessage: vi.fn(),
    startOperation: vi.fn(() => ({
      abortController: new AbortController(),
      operationId: 'local-member-op',
    })),
    updateOperationMetadata: vi.fn(),
  }) as unknown as ChatStore;

describe('createGatewayMemberStreamHandler', () => {
  it('clears visible loading for the local member op without completing it', () => {
    // The member row is already hydrated into the store (group hydration done),
    // so the visible_output_end hint is honored.
    const store = createStore({
      [bucketKey]: [{ content: 'hello', id: 'member-msg', role: 'assistant' }],
    });
    const handler = createGatewayMemberStreamHandler(() => store, {
      context,
      ensureGroupHydrated: vi.fn().mockResolvedValue(undefined),
      memberOperationId: 'server-member-op',
      parentOperationId: 'owner-op',
    });

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    handler(makeEvent('visible_output_end'));

    expect(store.updateOperationMetadata).toHaveBeenCalledWith('local-member-op', {
      visibleLoadingDone: true,
    });
    expect(store.completeOperation).not.toHaveBeenCalled();
  });

  it('paints generated files into the member column, deduped by file id', () => {
    const store = createStore({
      [bucketKey]: [{ content: '', id: 'member-msg', role: 'assistant' }],
    });
    const handler = createGatewayMemberStreamHandler(() => store, {
      context,
      ensureGroupHydrated: vi.fn().mockResolvedValue(undefined),
      memberOperationId: 'server-member-op',
      parentOperationId: 'owner-op',
    });

    const report = {
      fileType: 'application/pdf',
      id: 'file-1',
      name: 'report.pdf',
      size: 1024,
      url: 'https://app.example.com/f/file-1',
    };
    const sheet = {
      fileType: 'text/csv',
      id: 'file-2',
      name: 'data.csv',
      size: 12,
      url: 'https://app.example.com/f/file-2',
    };

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    handler(makeEvent('stream_chunk', { chunkType: 'file', file: report }));
    handler(makeEvent('stream_chunk', { chunkType: 'file', file: sheet }));
    // a replayed chunk (reconnect resume) must not duplicate the card
    handler(makeEvent('stream_chunk', { chunkType: 'file', file: report }));

    expect(store.internal_dispatchMessage).toHaveBeenCalledTimes(2);
    expect(store.internal_dispatchMessage).toHaveBeenLastCalledWith(
      { id: 'member-msg', type: 'updateMessage', value: { fileList: [report, sheet] } },
      { operationId: 'local-member-op' },
    );
  });

  it('repaints files accumulated before the group tree hydrated', async () => {
    // The member row only lands in the store once `ensureGroupHydrated` resolves,
    // so a file chunk arriving first must be repainted afterwards.
    const dbMessagesMap: Record<string, any[]> = {};
    const store = createStore(dbMessagesMap);
    let finishHydration = () => {};
    const hydrated = new Promise<void>((resolve) => {
      finishHydration = () => {
        dbMessagesMap[bucketKey] = [{ content: '', id: 'member-msg', role: 'assistant' }];
        resolve();
      };
    });
    const handler = createGatewayMemberStreamHandler(() => store, {
      context,
      ensureGroupHydrated: () => hydrated,
      memberOperationId: 'server-member-op',
      parentOperationId: 'owner-op',
    });

    const report = {
      fileType: 'application/pdf',
      id: 'file-1',
      name: 'report.pdf',
      size: 1024,
      url: 'https://app.example.com/f/file-1',
    };

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    handler(makeEvent('stream_chunk', { chunkType: 'file', file: report }));
    // dropped: the row isn't in the store yet
    expect(store.internal_dispatchMessage).not.toHaveBeenCalled();

    finishHydration();
    await vi.waitFor(() => expect(store.internal_dispatchMessage).toHaveBeenCalled());
    expect(store.internal_dispatchMessage).toHaveBeenCalledWith(
      { id: 'member-msg', type: 'updateMessage', value: { fileList: [report] } },
      { operationId: 'local-member-op' },
    );
  });

  it('skips the visible loading hint while the member row is not yet in the store (LOBE-11501)', () => {
    // Group hydration is still in flight, so the member row hasn't landed. Clearing
    // loading here would show a "done" column with no text — the guard skips it and
    // lets the terminal barrier reconcile.
    const store = createStore();
    const handler = createGatewayMemberStreamHandler(() => store, {
      context,
      ensureGroupHydrated: vi.fn().mockResolvedValue(undefined),
      memberOperationId: 'server-member-op',
      parentOperationId: 'owner-op',
    });

    handler(makeEvent('stream_start', { assistantMessage: { id: 'member-msg' } }));
    handler(makeEvent('visible_output_end'));

    expect(store.updateOperationMetadata).not.toHaveBeenCalled();
  });
});
