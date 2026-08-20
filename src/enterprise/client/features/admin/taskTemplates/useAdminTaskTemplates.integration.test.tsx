// @vitest-environment happy-dom
import { act, render, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { useEffect, useState } from 'react';
import { type Cache, SWRConfig, useSWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type PlatformTaskTemplatesState,
  usePlatformTaskTemplates,
} from '@/enterprise/client/hooks/usePlatformTaskTemplates';
import { setScopedMutate } from '@/libs/swr';

import { refreshAdminTaskTemplateLists } from './useAdminTaskTemplates';

/**
 * Runs against a REAL SWR cache — `@/libs/swr` is deliberately not mocked.
 *
 * The bug this guards is invisible to a mock: `mutate(predicate)` reaches mounted subscribers
 * only, and the home recommendations's hook is unmounted the whole time the operator is on an admin
 * page. Asserting "mutate was called" passes either way; the only thing that separates a
 * revalidation from an eviction is what a *later mount* sees on its first frame.
 *
 * The SWR provider therefore stays mounted for the whole test (as it does in the SPA) and only the
 * reader is mounted and unmounted, the way navigating to and from home behaves.
 */
const templates = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock('@/enterprise/client/services/platform', () => ({
  fetchPlatformTaskTemplates: () =>
    Promise.resolve({ managed: true, templates: templates.current }),
}));

vi.mock('@/enterprise/client/services/adminTaskTemplates', () => ({
  adminTaskTemplatesService: { list: vi.fn() },
}));

vi.mock('@/store/serverConfig', () => ({
  useServerConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ serverConfig: { enterprise: { platformAdmin: true } }, serverConfigInit: true }),
}));

const card = (title: string) => ({
  category: 'engineering',
  connectors: [],
  cronPattern: '0 9 * * *',
  description: '',
  icon: null,
  id: 'tpl-1',
  identifier: 'daily-digest',
  instruction: 'Summarize yesterday.',
  interests: [],
  title,
});

/** Every frame the reader rendered, so the *first* one after a remount can be inspected. */
let frames: PlatformTaskTemplatesState[] = [];
let cache: Map<unknown, unknown>;
let showReader!: (open: boolean) => void;

const Reader = () => {
  frames.push(usePlatformTaskTemplates());
  return null;
};

/** Mirrors `SWRMutateInitializer`: publishes the scoped mutate for use outside React. */
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

/** One long-lived SWR provider, one modal that opens and closes inside it. */
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
  templates.current = [card('Before the edit')];
});

describe('refreshAdminTaskTemplateLists against a real SWR cache', () => {
  it('serves the operator fresh examples after an admin write, with no stale frame', async () => {
    // 1. The operator opens the home recommendations once: the served list lands in the cache.
    mountApp();
    await waitFor(() => expect(current().templates).toHaveLength(1));
    expect(current().templates[0]!.title).toBe('Before the edit');

    // 2. They navigate to the admin console — the reader unmounts, the cache entry stays.
    act(() => showReader(false));

    // 3. They edit the template there.
    templates.current = [card('After the edit')];
    await act(async () => {
      await refreshAdminTaskTemplateLists();
    });

    // 4. They go back home. Nothing stale may be rendered on the way to the fresh list: with
    //    a revalidate-only invalidation the first frame here carried "Before the edit".
    frames = [];
    act(() => showReader(true));
    const beforeTheFetchLands = [...frames];

    // The point of the fix: the remounted reader starts from nothing, never from the old rows.
    expect(beforeTheFetchLands.every((frame) => frame.templates.length === 0)).toBe(true);
    expect(
      beforeTheFetchLands.some((frame) => frame.templates[0]?.title === 'Before the edit'),
    ).toBe(false);
    // SWR reports `isLoading: false` on the very first render (it decides to revalidate in an
    // effect); `usePlatformTaskTemplates` must still report "unknown" for that frame so a
    // managed tenant never flashes the market recommendations.
    expect(beforeTheFetchLands.every((frame) => frame.resolved === false)).toBe(true);

    await waitFor(() => expect(current().templates).toHaveLength(1));
    expect(current().templates[0]!.title).toBe('After the edit');
  });

  it('leaves no data behind in the cache for the evicted keys', async () => {
    mountApp();
    await waitFor(() => expect(current().templates).toHaveLength(1));
    act(() => showReader(false));

    await act(async () => {
      await refreshAdminTaskTemplateLists();
    });

    const entries = [...cache.values()] as { data?: unknown }[];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry?.data === undefined)).toBe(true);
  });

  it('refreshes a still-mounted reader in place instead of stranding it empty', async () => {
    // The console and home can be open at once; a mounted reader must land on the new data,
    // not merely be cleared.
    mountApp();
    await waitFor(() => expect(current().templates).toHaveLength(1));

    templates.current = [card('After the edit')];
    await act(async () => {
      await refreshAdminTaskTemplateLists();
    });

    await waitFor(() => expect(current().templates[0]!.title).toBe('After the edit'));
  });
});
