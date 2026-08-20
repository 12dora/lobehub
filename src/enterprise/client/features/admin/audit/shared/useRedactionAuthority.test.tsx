/**
 * Redaction authority against a REAL SWR cache and the REAL purger.
 * @vitest-environment happy-dom
 */
import { act, render, waitFor } from '@testing-library/react';
import type { PropsWithChildren, ReactNode } from 'react';
import { StrictMode, useEffect, useState } from 'react';
import useSWR, { type Cache, SWRConfig, useSWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setScopedMutate } from '@/libs/swr';

import {
  ADMIN_AUDIT_POLICY_KEY,
  buildAdminAuditConversationGetKey,
  buildAdminAuditConversationMessagesKey,
  buildAdminAuditConversationsListKey,
  buildAdminAuditUserTimelineKey,
} from '../swrKeys';
import { isAuditConversationEvidenceKey } from './purgeConversationEvidence';
import {
  emptyRedactionSlots,
  envelopeSlot,
  type RedactionSlots,
  selectRenderablePages,
} from './redactionAuthority';
import { useRedactionAuthority } from './useRedactionAuthority';

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345';
const from = new Date('2026-06-01T00:00:00.000Z');
const to = new Date('2026-08-01T00:00:00.000Z');

const KEYS = {
  listHead: buildAdminAuditConversationsListKey({ limit: 30, userId: 'u1' }),
  listOlder: buildAdminAuditConversationsListKey({ cursor: 'c-older', limit: 30, userId: 'u1' }),
  topicA: buildAdminAuditConversationGetKey('u1', 't-a'),
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
  policy: [ADMIN_AUDIT_POLICY_KEY] as const,
};

const purgeActual = vi.hoisted(() => ({
  run: async () => undefined as unknown,
}));
const purgeSpy = vi.hoisted(() => vi.fn(async () => purgeActual.run()));

vi.mock('./purgeConversationEvidence', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    isAuditConversationEvidenceKey: (key: unknown) => boolean;
    purgeAuditConversationEvidenceCaches: () => Promise<unknown>;
  };
  purgeActual.run = actual.purgeAuditConversationEvidenceCaches;
  return {
    ...actual,
    isAuditConversationEvidenceKey: actual.isAuditConversationEvidenceKey,
    purgeAuditConversationEvidenceCaches: purgeSpy,
  };
});

const slotsOf = (partial: Partial<RedactionSlots>): RedactionSlots => ({
  ...emptyRedactionSlots(),
  ...partial,
});

type PageFrame = { bodies: string[]; head: string };

let frames: PageFrame[] = [];
let cache: Map<unknown, unknown>;
let served = { body: SECRET, redactionProfile: 'off' as string };
const pollFetcher = vi.fn(async () => ({ body: SECRET, redactionProfile: 'off' as const }));

const MutateBridge = ({ children }: PropsWithChildren) => {
  const { mutate } = useSWRConfig();
  useEffect(() => setScopedMutate(mutate), [mutate]);
  return <>{children}</>;
};

const Seed = () => {
  useSWR(KEYS.listHead, () => served);
  useSWR(KEYS.listOlder, () => served);
  useSWR(KEYS.topicA, () => served);
  useSWR(KEYS.messagesHead, () => served);
  useSWR(KEYS.messagesOlder, () => served);
  useSWR(KEYS.timelineHead, () => served);
  useSWR(KEYS.policy, () => served);
  return null;
};

const remainingSecrets = () =>
  [...cache.entries()].filter(([, entry]) => {
    const body = (entry as { data?: { body?: string } } | undefined)?.data?.body;
    return body === SECRET;
  });

const mount = (ui: ReactNode, { strict = false }: { strict?: boolean } = {}) => {
  cache = new Map();
  const tree = (
    <SWRConfig value={{ dedupingInterval: 0, provider: () => cache as unknown as Cache }}>
      <MutateBridge>{ui}</MutateBridge>
    </SWRConfig>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
};

const PersistentDisagreementProbe = () => {
  const messages = useSWR(['redaction-authority-poll-messages'], pollFetcher, {
    refreshInterval: 20,
  });
  const authority = useRedactionAuthority(
    slotsOf({
      messages: envelopeSlot(messages.data),
      policy: 'strict',
    }),
    [],
    'poll',
  );
  const body = authority.isEnvelopeRenderable(envelopeSlot(messages.data))
    ? messages.data?.body
    : undefined;
  frames.push({
    bodies: body ? [body] : [],
    head: messages.data?.redactionProfile ?? 'pending',
  });
  return <div data-secret={body === SECRET ? '1' : '0'} data-testid="probe" />;
};

const TighteningHost = () => {
  const [profile, setProfile] = useState('off');
  useRedactionAuthority(slotsOf({ messages: profile }), [], 'one');
  return (
    <button data-testid="tighten" type="button" onClick={() => setProfile('strict')}>
      tighten
    </button>
  );
};

const PolicyShrinkHost = () => {
  const [policy, setPolicy] = useState<string | undefined>('strict');
  const authority = useRedactionAuthority(slotsOf({ list: 'off', policy }), [], 'shrink');
  frames.push({
    bodies: authority.isEnvelopeRenderable('off') ? [SECRET] : [],
    head: authority.effective ?? 'none',
  });
  return (
    <button data-testid="drop-policy" type="button" onClick={() => setPolicy(undefined)}>
      drop
    </button>
  );
};

const OlderPagesHost = () => {
  const [head, setHead] = useState('off');
  const older = [{ body: SECRET, redactionProfile: 'off' }];
  const extra = older.map((page) => page.redactionProfile);
  const authority = useRedactionAuthority(slotsOf({ messages: head }), extra, 'pages');
  const items = selectRenderablePages(
    [
      {
        items: [{ body: head === 'off' ? SECRET : '[REDACTED]', id: 'head' }],
        redactionProfile: head,
      },
      ...older.map((page, index) => ({
        items: [{ body: page.body, id: `old-${index}` }],
        redactionProfile: page.redactionProfile,
      })),
    ],
    authority.isEnvelopeRenderable,
  );
  const bodies = items.map((item) => item.body);
  frames.push({ bodies, head });
  return (
    <div>
      <div data-testid="bodies">{bodies.join('|')}</div>
      <button data-testid="tighten-head" type="button" onClick={() => setHead('strict')}>
        tighten
      </button>
    </div>
  );
};

const MissingProfileProbe = () => {
  const envelope = useSWR(['redaction-authority-missing'], async () => ({
    body: SECRET,
  }));
  const authority = useRedactionAuthority(
    slotsOf({ messages: envelopeSlot(envelope.data) }),
    [],
    'missing',
  );
  const body = authority.isEnvelopeRenderable(envelopeSlot(envelope.data))
    ? envelope.data?.body
    : undefined;
  frames.push({ bodies: body ? [body] : [], head: envelopeSlot(envelope.data) ?? 'pending' });
  return <div data-secret={body === SECRET ? '1' : '0'} data-testid="missing" />;
};

beforeEach(() => {
  frames = [];
  cache = new Map();
  served = { body: SECRET, redactionProfile: 'off' };
  pollFetcher.mockClear();
  purgeSpy.mockClear();
});

describe('useRedactionAuthority', () => {
  it('purges exactly once under persistent disagreement across 5 polls', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mount(<PersistentDisagreementProbe />);

      await waitFor(() => expect(pollFetcher).toHaveBeenCalled());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20 * 5);
      });

      expect(purgeSpy).toHaveBeenCalledTimes(1);
      expect(frames.every((frame) => !frame.bodies.includes(SECRET))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('purges exactly once on unanimous off → strict, evicts every evidence key, and works under StrictMode', async () => {
    const { getByTestId } = mount(
      <>
        <Seed />
        <TighteningHost />
      </>,
      { strict: true },
    );

    await waitFor(() => expect(remainingSecrets().length).toBeGreaterThan(1));
    expect(purgeSpy).not.toHaveBeenCalled();

    served = { body: '[REDACTED]', redactionProfile: 'strict' };
    await act(async () => {
      getByTestId('tighten').click();
    });

    await waitFor(() => expect(purgeSpy).toHaveBeenCalledTimes(1));

    const leftover = remainingSecrets();
    expect(leftover.every(([key]) => !isAuditConversationEvidenceKey(key))).toBe(true);
    expect(leftover.every(([key]) => JSON.stringify(key).includes(ADMIN_AUDIT_POLICY_KEY))).toBe(
      true,
    );
  });

  it('cannot loosen when the policy slot shrinks or goes absent', async () => {
    const { getByTestId } = mount(<PolicyShrinkHost />);
    expect(frames.at(-1)?.head).toBe('strict');
    expect(frames.at(-1)?.bodies).toEqual([]);

    await act(async () => {
      getByTestId('drop-policy').click();
    });

    expect(frames.at(-1)?.head).toBe('strict');
    expect(frames.every((frame) => !frame.bodies.includes(SECRET))).toBe(true);
  });

  it('excludes accumulated older off pages in every committed frame once the head is strict', async () => {
    const { getByTestId } = mount(<OlderPagesHost />);
    expect(frames.some((frame) => frame.bodies.includes(SECRET))).toBe(true);

    await act(async () => {
      getByTestId('tighten-head').click();
    });

    expect(
      frames
        .filter((frame) => frame.head === 'strict')
        .every((frame) => !frame.bodies.includes(SECRET)),
    ).toBe(true);
    expect(frames.at(-1)?.bodies).toEqual(['[REDACTED]']);
  });

  it('does not render a present envelope whose profile is missing', async () => {
    mount(<MissingProfileProbe />);
    await waitFor(() => expect(frames.some((frame) => frame.head === 'unknown')).toBe(true));
    expect(frames.every((frame) => !frame.bodies.includes(SECRET))).toBe(true);
  });
});
