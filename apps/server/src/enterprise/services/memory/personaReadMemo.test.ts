// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { getLatestPersonaDocumentMemo, resetPersonaReadMemoForTest } from './personaReadMemo';

const getLatestPersonaDocument = vi.hoisted(() => vi.fn());
const isModuleEnabled = vi.hoisted(() => vi.fn());

vi.mock('@/database/models/userMemory/persona', () => ({
  UserPersonaModel: class {
    getLatestPersonaDocument = getLatestPersonaDocument;
  },
}));

vi.mock('../moduleSettings', () => ({
  isModuleEnabled,
}));

describe('personaReadMemo', () => {
  const db = {} as LobeChatDatabase;

  beforeEach(() => {
    resetPersonaReadMemoForTest();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'));
    isModuleEnabled.mockResolvedValue(true);
    getLatestPersonaDocument.mockResolvedValue({ persona: 'p1', tagline: 't', version: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips the DB when the memory module is off', async () => {
    isModuleEnabled.mockResolvedValue(false);

    await expect(getLatestPersonaDocumentMemo({ db, userId: 'u1' })).resolves.toBeNull();
    expect(getLatestPersonaDocument).not.toHaveBeenCalled();
  });

  it('dedupes reads within the 15s TTL', async () => {
    const first = await getLatestPersonaDocumentMemo({ db, userId: 'u1' });
    vi.advanceTimersByTime(14_000);
    const second = await getLatestPersonaDocumentMemo({ db, userId: 'u1' });

    expect(second).toBe(first);
    expect(getLatestPersonaDocument).toHaveBeenCalledTimes(1);
  });

  it('reloads after TTL expiry', async () => {
    await getLatestPersonaDocumentMemo({ db, userId: 'u1' });
    getLatestPersonaDocument.mockResolvedValue({ persona: 'p2', version: 2 });
    vi.advanceTimersByTime(15_001);

    const next = await getLatestPersonaDocumentMemo({ db, userId: 'u1' });
    expect(next).toEqual({ persona: 'p2', version: 2 });
    expect(getLatestPersonaDocument).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent reads', async () => {
    let resolveDoc: (value: { persona: string }) => void = () => undefined;
    getLatestPersonaDocument.mockReturnValue(
      new Promise((resolve) => {
        resolveDoc = resolve;
      }),
    );

    const a = getLatestPersonaDocumentMemo({ db, userId: 'u-flight' });
    const b = getLatestPersonaDocumentMemo({ db, userId: 'u-flight' });
    resolveDoc({ persona: 'shared' });

    await expect(Promise.all([a, b])).resolves.toEqual([
      { persona: 'shared' },
      { persona: 'shared' },
    ]);
    expect(getLatestPersonaDocument).toHaveBeenCalledTimes(1);
  });

  it('does not evict an in-flight slot at cap+1 concurrent keys', async () => {
    vi.useRealTimers();
    resetPersonaReadMemoForTest({ maxEntries: 2 });
    const resolvers: Array<(value: { persona: string }) => void> = [];
    getLatestPersonaDocument.mockImplementation(
      () =>
        new Promise<{ persona: string }>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const first = getLatestPersonaDocumentMemo({ db, userId: 'k1' });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const second = getLatestPersonaDocumentMemo({ db, userId: 'k2' });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    const third = getLatestPersonaDocumentMemo({ db, userId: 'k3' });
    await vi.waitFor(() => expect(resolvers).toHaveLength(3));

    const firstAgain = getLatestPersonaDocumentMemo({ db, userId: 'k1' });
    await vi.waitFor(() => expect(getLatestPersonaDocument).toHaveBeenCalledTimes(3));

    resolvers[0]({ persona: 'k1' });
    resolvers[1]({ persona: 'k2' });
    resolvers[2]({ persona: 'k3' });

    await expect(Promise.all([first, firstAgain, second, third])).resolves.toEqual([
      { persona: 'k1' },
      { persona: 'k1' },
      { persona: 'k2' },
      { persona: 'k3' },
    ]);
    expect(getLatestPersonaDocument).toHaveBeenCalledTimes(3);
  });
});
