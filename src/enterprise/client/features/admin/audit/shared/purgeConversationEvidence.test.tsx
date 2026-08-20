/**
 * Global conversation-evidence purge against a REAL SWR cache.
 * Bound hook `mutate` only touches the active key; this asserts every
 * cursor/topic/page-size entry is evicted, including unmounted ones.
 * @vitest-environment happy-dom
 */
import { act, render, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { useEffect, useState } from 'react';
import useSWR, { type Cache, SWRConfig, useSWRConfig } from 'swr';
import { beforeEach, describe, expect, it } from 'vitest';

import { setScopedMutate } from '@/libs/swr';

import {
  ADMIN_AUDIT_CONVERSATIONS_LIST_KEY,
  ADMIN_AUDIT_POLICY_KEY,
  buildAdminAuditConversationGetKey,
  buildAdminAuditConversationMessagesKey,
  buildAdminAuditConversationsListKey,
  buildAdminAuditUserTimelineKey,
} from '../swrKeys';
import {
  isAuditConversationEvidenceKey,
  purgeAuditConversationEvidenceCaches,
} from './purgeConversationEvidence';

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345';
const from = new Date('2026-06-01T00:00:00.000Z');
const to = new Date('2026-08-01T00:00:00.000Z');

const KEYS = {
  listHead: buildAdminAuditConversationsListKey({ limit: 30, userId: 'u1' }),
  listOlder: buildAdminAuditConversationsListKey({ cursor: 'c-older', limit: 30, userId: 'u1' }),
  topicA: buildAdminAuditConversationGetKey('u1', 't-a'),
  topicB: buildAdminAuditConversationGetKey('u1', 't-b'),
  messagesHead: buildAdminAuditConversationMessagesKey({
    includeBody: true,
    limit: 100,
    topicId: 't-a',
    userId: 'u1',
  }),
  messagesOlder: buildAdminAuditConversationMessagesKey({
    cursor: 'msg-older',
    includeBody: true,
    limit: 100,
    topicId: 't-a',
    userId: 'u1',
  }),
  timelineHead: buildAdminAuditUserTimelineKey({ from, limit: 30, to, userId: 'u1' }),
  timelineOlder: buildAdminAuditUserTimelineKey({
    cursor: 'tl-2',
    from,
    limit: 50,
    to,
    userId: 'u1',
  }),
  policy: [ADMIN_AUDIT_POLICY_KEY] as const,
};

let served = { body: SECRET, redactionProfile: 'off' as const };
let frames: Array<Record<string, { body?: string } | undefined>> = [];
let cache: Map<unknown, unknown>;
let showReader!: (open: boolean) => void;

const fetcher = async () => served;

const Reader = () => {
  const listHead = useSWR(KEYS.listHead, fetcher);
  const listOlder = useSWR(KEYS.listOlder, fetcher);
  const topicA = useSWR(KEYS.topicA, fetcher);
  const topicB = useSWR(KEYS.topicB, fetcher);
  const messagesHead = useSWR(KEYS.messagesHead, fetcher);
  const messagesOlder = useSWR(KEYS.messagesOlder, fetcher);
  const timelineHead = useSWR(KEYS.timelineHead, fetcher);
  const timelineOlder = useSWR(KEYS.timelineOlder, fetcher);
  const policy = useSWR(KEYS.policy, fetcher);
  frames.push({
    listHead: listHead.data,
    listOlder: listOlder.data,
    messagesHead: messagesHead.data,
    messagesOlder: messagesOlder.data,
    policy: policy.data,
    timelineHead: timelineHead.data,
    timelineOlder: timelineOlder.data,
    topicA: topicA.data,
    topicB: topicB.data,
  });
  return null;
};

const MutateBridge = ({ children }: PropsWithChildren) => {
  const { mutate } = useSWRConfig();
  useEffect(() => setScopedMutate(mutate), [mutate]);
  return <>{children}</>;
};

const Host = () => {
  const [open, setOpen] = useState(true);
  showReader = setOpen;
  return open ? <Reader /> : null;
};

const mountApp = () =>
  render(
    <SWRConfig value={{ provider: () => cache as unknown as Cache }}>
      <MutateBridge>
        <Host />
      </MutateBridge>
    </SWRConfig>,
  );

const current = () => frames.at(-1)!;

beforeEach(() => {
  cache = new Map();
  frames = [];
  served = { body: SECRET, redactionProfile: 'off' };
});

describe('isAuditConversationEvidenceKey', () => {
  it('matches conversation list/get/messages/timeline prefixes and ignores policy', () => {
    expect(isAuditConversationEvidenceKey(KEYS.listOlder)).toBe(true);
    expect(isAuditConversationEvidenceKey(KEYS.topicB)).toBe(true);
    expect(isAuditConversationEvidenceKey(KEYS.messagesOlder)).toBe(true);
    expect(isAuditConversationEvidenceKey(KEYS.timelineOlder)).toBe(true);
    expect(isAuditConversationEvidenceKey([...KEYS.messagesOlder, 'ws-1'])).toBe(true);
    expect(isAuditConversationEvidenceKey(KEYS.policy)).toBe(false);
    expect(isAuditConversationEvidenceKey(ADMIN_AUDIT_CONVERSATIONS_LIST_KEY)).toBe(false);
    expect(isAuditConversationEvidenceKey(null)).toBe(false);
  });
});

describe('purgeAuditConversationEvidenceCaches against a real SWR cache', () => {
  it('evicts every cursor/topic evidence key so a remount never flashes raw off payloads', async () => {
    mountApp();
    await waitFor(() => expect(current().messagesOlder?.body).toBe(SECRET));
    expect(current().listOlder?.body).toBe(SECRET);
    expect(current().topicB?.body).toBe(SECRET);
    expect(current().timelineOlder?.body).toBe(SECRET);
    expect(current().policy?.body).toBe(SECRET);

    act(() => showReader(false));

    served = { body: '[REDACTED]', redactionProfile: 'off' };
    await act(async () => {
      await purgeAuditConversationEvidenceCaches();
    });

    const serialized = (key: unknown) => (typeof key === 'string' ? key : JSON.stringify(key));
    const remainingSecrets = [...cache.entries()].filter(([, entry]) => {
      const body = (entry as { data?: { body?: string } } | undefined)?.data?.body;
      return body === SECRET;
    });
    expect(remainingSecrets.length).toBeGreaterThan(0);
    expect(
      remainingSecrets.every(([key]) => serialized(key).includes(ADMIN_AUDIT_POLICY_KEY)),
    ).toBe(true);
    expect(
      remainingSecrets.some(([key]) =>
        serialized(key).includes(ADMIN_AUDIT_CONVERSATIONS_LIST_KEY),
      ),
    ).toBe(false);

    frames = [];
    act(() => showReader(true));
    const beforeFetch = [...frames];
    expect(beforeFetch.every((frame) => frame.messagesOlder?.body !== SECRET)).toBe(true);
    expect(beforeFetch.every((frame) => frame.listOlder?.body !== SECRET)).toBe(true);
    expect(beforeFetch.every((frame) => frame.topicB?.body !== SECRET)).toBe(true);
    expect(beforeFetch.every((frame) => frame.timelineOlder?.body !== SECRET)).toBe(true);

    await waitFor(() => expect(current().messagesOlder?.body).toBe('[REDACTED]'));
    expect(current().listOlder?.body).toBe('[REDACTED]');
    expect(current().topicB?.body).toBe('[REDACTED]');
    expect(current().timelineOlder?.body).toBe('[REDACTED]');
    expect(current().policy?.body).toBe(SECRET);
  });
});
