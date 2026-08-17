// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { getInfoForAIGenerationMemo, resetUserInfoReadMemoForTest } from './userInfoReadMemo';

const getInfoForAIGeneration = vi.hoisted(() => vi.fn());

vi.mock('@/database/models/user', () => ({
  UserModel: { getInfoForAIGeneration },
}));

describe('userInfoReadMemo', () => {
  const db = {} as LobeChatDatabase;

  beforeEach(() => {
    resetUserInfoReadMemoForTest();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'));
    getInfoForAIGeneration.mockResolvedValue({ responseLanguage: 'en-US', userName: 'Ada' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hits the DB once within the 30s TTL', async () => {
    const first = await getInfoForAIGenerationMemo(db, 'u1');
    vi.advanceTimersByTime(29_000);
    const second = await getInfoForAIGenerationMemo(db, 'u1');

    expect(second).toBe(first);
    expect(getInfoForAIGeneration).toHaveBeenCalledTimes(1);
  });

  it('reloads after TTL expiry', async () => {
    await getInfoForAIGenerationMemo(db, 'u1');
    getInfoForAIGeneration.mockResolvedValue({ responseLanguage: 'zh-CN', userName: 'Ada' });
    vi.advanceTimersByTime(30_001);

    await expect(getInfoForAIGenerationMemo(db, 'u1')).resolves.toEqual({
      responseLanguage: 'zh-CN',
      userName: 'Ada',
    });
    expect(getInfoForAIGeneration).toHaveBeenCalledTimes(2);
  });

  it('does not evict an in-flight slot at cap+1 concurrent keys', async () => {
    resetUserInfoReadMemoForTest({ maxEntries: 2 });
    const resolvers: Array<(value: { responseLanguage: string; userName: string }) => void> = [];
    getInfoForAIGeneration.mockImplementation(
      () =>
        new Promise<{ responseLanguage: string; userName: string }>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const first = getInfoForAIGenerationMemo(db, 'k1');
    const second = getInfoForAIGenerationMemo(db, 'k2');
    const third = getInfoForAIGenerationMemo(db, 'k3');
    const firstAgain = getInfoForAIGenerationMemo(db, 'k1');

    expect(getInfoForAIGeneration).toHaveBeenCalledTimes(3);
    expect(resolvers).toHaveLength(3);

    resolvers[0]({ responseLanguage: 'en-US', userName: 'k1' });
    resolvers[1]({ responseLanguage: 'en-US', userName: 'k2' });
    resolvers[2]({ responseLanguage: 'en-US', userName: 'k3' });

    await expect(Promise.all([first, firstAgain, second, third])).resolves.toEqual([
      { responseLanguage: 'en-US', userName: 'k1' },
      { responseLanguage: 'en-US', userName: 'k1' },
      { responseLanguage: 'en-US', userName: 'k2' },
      { responseLanguage: 'en-US', userName: 'k3' },
    ]);
    expect(getInfoForAIGeneration).toHaveBeenCalledTimes(3);
  });
});
