// @vitest-environment node
import { REQUEST_AGENT_ID_HEADER, REQUEST_TOPIC_ID_HEADER } from '@lobechat/const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type LobeChatDatabase } from '@/database/type';

import {
  readConversationSourceFromRequest,
  rememberModelRuntimeConversationStartMs,
  resetModelRuntimeConversationRegistry,
  resolveModelRuntimeConversation,
} from './conversationIdentity';

const { findById } = vi.hoisted(() => ({ findById: vi.fn() }));

vi.mock('@/database/models/topic', () => ({
  TopicModel: vi.fn().mockImplementation(() => ({ findById })),
}));

const db = {} as LobeChatDatabase;
const TOPIC_CREATED_AT = new Date('2026-08-18T02:15:00.000Z');

beforeEach(() => {
  resetModelRuntimeConversationRegistry();
  findById.mockReset();
  findById.mockResolvedValue({ createdAt: TOPIC_CREATED_AT, id: 'topic-1' });
});

describe('resolveModelRuntimeConversation', () => {
  it('derives the SAME identity on two replicas, because both read the topic row', async () => {
    const replicaA = await resolveModelRuntimeConversation({
      db,
      topicId: 'topic-1',
      userId: 'u1',
    });

    // A second process (or this one after a restart) has an empty registry.
    resetModelRuntimeConversationRegistry();
    const replicaB = await resolveModelRuntimeConversation({
      agentId: 'agent-1',
      db,
      topicId: 'topic-1',
      userId: 'u1',
    });

    expect(replicaA).toEqual({
      conversationKey: 'user:u1:topic:topic-1',
      firstSeenMs: TOPIC_CREATED_AT.getTime(),
    });
    expect(replicaB).toEqual(replicaA);
  });

  it('gives two topics two different identities', async () => {
    findById.mockResolvedValueOnce({ createdAt: TOPIC_CREATED_AT });
    findById.mockResolvedValueOnce({ createdAt: new Date('2026-08-18T05:00:00.000Z') });

    const a = await resolveModelRuntimeConversation({ db, topicId: 'topic-a', userId: 'u1' });
    const b = await resolveModelRuntimeConversation({ db, topicId: 'topic-b', userId: 'u1' });

    expect(a.conversationKey).not.toBe(b.conversationKey);
    expect(a.firstSeenMs).not.toBe(b.firstSeenMs);
  });

  it('reads the topic row ONCE for concurrent first turns and never again', async () => {
    let release: (value: { createdAt: Date }) => void = () => {};
    findById.mockReturnValueOnce(
      new Promise<{ createdAt: Date }>((resolve) => {
        release = resolve;
      }),
    );

    const concurrent = Promise.all(
      Array.from({ length: 5 }, () =>
        resolveModelRuntimeConversation({ db, topicId: 'topic-1', userId: 'u1' }),
      ),
    );
    release({ createdAt: TOPIC_CREATED_AT });
    const resolved = await concurrent;
    await resolveModelRuntimeConversation({ db, topicId: 'topic-1', userId: 'u1' });

    expect(findById).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledWith('topic-1');
    for (const conversation of resolved) expect(conversation).toEqual(resolved[0]);
  });

  it('keeps two users apart even on the same topic id', async () => {
    const mine = await resolveModelRuntimeConversation({ db, topicId: 'topic-1', userId: 'u1' });
    const theirs = await resolveModelRuntimeConversation({ db, topicId: 'topic-1', userId: 'u2' });

    expect(mine.conversationKey).not.toBe(theirs.conversationKey);
  });

  it('mints ONE pending identity for the topic-less first turn of an agent', async () => {
    const first = await resolveModelRuntimeConversation(
      { agentId: 'agent-1', db, userId: 'u1' },
      1000,
    );
    const retry = await resolveModelRuntimeConversation(
      { agentId: 'agent-1', db, userId: 'u1' },
      5000,
    );

    expect(first).toEqual({ conversationKey: 'user:u1:agent:agent-1:pending', firstSeenMs: 1000 });
    // Same pre-topic conversation → same session id, no DB read at all.
    expect(retry).toEqual(first);
    expect(findById).not.toHaveBeenCalled();
  });

  it('does NOT graduate the pending identity onto the topic (documented discontinuity)', async () => {
    const pending = await resolveModelRuntimeConversation({ agentId: 'agent-1', db, userId: 'u1' });
    const withTopic = await resolveModelRuntimeConversation({
      agentId: 'agent-1',
      db,
      topicId: 'topic-1',
      userId: 'u1',
    });

    expect(withTopic.conversationKey).not.toBe(pending.conversationKey);
    expect(withTopic.firstSeenMs).toBe(TOPIC_CREATED_AT.getTime());
  });

  it('remembers a first sighting when the topic row cannot be read, and retries later', async () => {
    findById.mockResolvedValueOnce(undefined);
    const first = await resolveModelRuntimeConversation(
      { db, topicId: 'topic-x', userId: 'u1' },
      2000,
    );
    const second = await resolveModelRuntimeConversation(
      { db, topicId: 'topic-x', userId: 'u1' },
      3000,
    );

    expect(first).toEqual({ conversationKey: 'user:u1:topic:topic-x', firstSeenMs: 2000 });
    // Within the miss TTL the row is not read again, and the identity does not move.
    expect(second).toEqual(first);
    expect(findById).toHaveBeenCalledTimes(1);

    // Once the miss expires the row is read again — the topic may exist by then.
    const later = await resolveModelRuntimeConversation(
      { db, topicId: 'topic-x', userId: 'u1' },
      Date.now() + 120_000,
    );
    expect(findById).toHaveBeenCalledTimes(2);
    expect(later.firstSeenMs).toBe(TOPIC_CREATED_AT.getTime());
  });

  it('survives a failing topic read', async () => {
    findById.mockRejectedValueOnce(new Error('connection terminated'));
    const failed = await resolveModelRuntimeConversation(
      { db, topicId: 'topic-y', userId: 'u1' },
      4000,
    );

    expect(failed).toEqual({ conversationKey: 'user:u1:topic:topic-y', firstSeenMs: 4000 });
  });

  it('gives a request with neither id its own one-off identity', async () => {
    const first = await resolveModelRuntimeConversation({ db, userId: 'u1' });
    const second = await resolveModelRuntimeConversation({ db, userId: 'u1' });

    expect(first.conversationKey).toMatch(/^user:u1:op:[\da-f-]{36}$/);
    expect(second.conversationKey).not.toBe(first.conversationKey);
  });
});

describe('rememberModelRuntimeConversationStartMs', () => {
  it('keeps one start time per caller-supplied key', () => {
    expect(rememberModelRuntimeConversationStartMs('user:u1:operation:op-1', 1000)).toBe(1000);
    expect(rememberModelRuntimeConversationStartMs('user:u1:operation:op-1', 9000)).toBe(1000);
    expect(rememberModelRuntimeConversationStartMs('user:u1:operation:op-2', 9000)).toBe(9000);
  });
});

describe('readConversationSourceFromRequest', () => {
  it('reads the agent and topic the SPA sends on every chat request', () => {
    const request = new Request('https://example.com/webapi/chat/grok', {
      headers: { [REQUEST_AGENT_ID_HEADER]: 'agent-1', [REQUEST_TOPIC_ID_HEADER]: 'topic-1' },
      method: 'POST',
    });

    expect(readConversationSourceFromRequest(request)).toEqual({
      agentId: 'agent-1',
      topicId: 'topic-1',
    });
  });

  it('prefers the trace payload topic and falls back to its session id', () => {
    const request = new Request('https://example.com/webapi/chat/grok', { method: 'POST' });

    expect(
      readConversationSourceFromRequest(request, { sessionId: 'agent-9', topicId: 'topic-9' }),
    ).toEqual({ agentId: 'agent-9', topicId: 'topic-9' });
    expect(readConversationSourceFromRequest(request)).toEqual({});
  });
});
