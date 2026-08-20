/**
 * Redaction authority against a REAL SWR cache: race, suppress, latched purge.
 * @vitest-environment happy-dom
 */
import { act, render, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { useEffect } from 'react';
import useSWR, { type Cache, SWRConfig, useSWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setScopedMutate } from '@/libs/swr';

import { useRedactionAuthority } from './useRedactionAuthority';

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345';

const purgeMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('./purgeConversationEvidence', () => ({
  purgeAuditConversationEvidenceCaches: () => purgeMock(),
}));

type Frame = {
  effective?: string;
  messagesBody?: string;
  renderable: boolean;
  showedSecret: boolean;
};

let frames: Frame[] = [];
let cache: Map<unknown, unknown>;
let resolveMessages!: (value: { body: string; redactionProfile: string }) => void;
let resolveTopics!: (value: { redactionProfile: string }) => void;
const pollFetcher = vi.fn(async () => ({ body: SECRET, redactionProfile: 'off' as const }));

const MutateBridge = ({ children }: PropsWithChildren) => {
  const { mutate } = useSWRConfig();
  useEffect(() => setScopedMutate(mutate), [mutate]);
  return <>{children}</>;
};

const Probe = ({
  policyProfile,
  refreshInterval = 0,
}: {
  policyProfile?: string;
  refreshInterval?: number;
}) => {
  const messages = useSWR(
    ['redaction-authority-messages'],
    () =>
      new Promise<{ body: string; redactionProfile: string }>((resolve) => {
        resolveMessages = resolve;
      }),
    { refreshInterval },
  );
  const topics = useSWR(
    ['redaction-authority-topics'],
    () =>
      new Promise<{ redactionProfile: string }>((resolve) => {
        resolveTopics = resolve;
      }),
  );
  const authority = useRedactionAuthority(
    [messages.data?.redactionProfile, topics.data?.redactionProfile, policyProfile],
    'u1:t1',
  );
  const renderable = authority.isEnvelopeRenderable(messages.data?.redactionProfile);
  const body = renderable ? messages.data?.body : undefined;
  frames.push({
    effective: authority.effective,
    messagesBody: body,
    renderable,
    showedSecret: body === SECRET,
  });
  return <div data-secret={body === SECRET ? '1' : '0'} data-testid="probe" />;
};

const mount = (props?: { policyProfile?: string; refreshInterval?: number }) => {
  cache = new Map();
  return render(
    <SWRConfig value={{ provider: () => cache as unknown as Cache }}>
      <MutateBridge>
        <Probe policyProfile={props?.policyProfile} refreshInterval={props?.refreshInterval} />
      </MutateBridge>
    </SWRConfig>,
  );
};

const PersistentDisagreementProbe = () => {
  const messages = useSWR(['redaction-authority-poll-messages'], pollFetcher, {
    refreshInterval: 20,
  });
  useRedactionAuthority([messages.data?.redactionProfile, 'strict'], 'poll');
  return null;
};

beforeEach(() => {
  frames = [];
  cache = new Map();
  pollFetcher.mockClear();
  purgeMock.mockClear();
  purgeMock.mockResolvedValue(undefined);
});

describe('useRedactionAuthority', () => {
  it('never renders raw bodies when off messages resolve before strict topics (policy already strict)', async () => {
    mount({ policyProfile: 'strict' });
    await waitFor(() => expect(typeof resolveMessages).toBe('function'));

    await act(async () => {
      resolveMessages({ body: SECRET, redactionProfile: 'off' });
    });
    expect(frames.some((frame) => frame.showedSecret)).toBe(false);

    await act(async () => {
      resolveTopics({ redactionProfile: 'strict' });
    });
    expect(frames.some((frame) => frame.showedSecret)).toBe(false);
    expect(frames.some((frame) => frame.effective === 'strict')).toBe(true);
    expect(purgeMock).toHaveBeenCalled();
  });

  it('purges once under persistent disagreement and stays bounded across poll ticks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <SWRConfig value={{ provider: () => new Map() as unknown as Cache, dedupingInterval: 0 }}>
          <MutateBridge>
            <PersistentDisagreementProbe />
          </MutateBridge>
        </SWRConfig>,
      );

      await waitFor(() => expect(pollFetcher).toHaveBeenCalled());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20 * 5);
      });

      expect(purgeMock.mock.calls.length).toBeLessThanOrEqual(2);
      expect(pollFetcher.mock.calls.length).toBeLessThanOrEqual(2 + 5);
    } finally {
      vi.useRealTimers();
    }
  });
});
