import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { messages, sessions, users, userSettings, workspaces } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { UserModel, UserNotFoundError } from '../user';

const userId = 'user-bundle-test';
const otherUserId = 'other-bundle-test';

const serverDB: LobeChatDatabase = await getTestDB();
const userModel = new UserModel(serverDB, userId);
const mockDecryptor = vi.fn().mockResolvedValue({ openai: { apiKey: 'sk-test' } });

describe('UserModel.getUserStateBundle', () => {
  beforeEach(async () => {
    await serverDB.delete(users);
    await serverDB.insert(users).values([
      { id: userId, email: 'bundle@example.com', fullName: 'Bundle User' },
      { id: otherUserId, email: 'other-bundle@example.com' },
    ]);
    mockDecryptor.mockClear();
    mockDecryptor.mockResolvedValue({ openai: { apiKey: 'sk-test' } });
  });

  afterEach(async () => {
    await serverDB.delete(users);
  });

  it('returns the same state shape as getUserState plus onboarding probes', async () => {
    await serverDB.insert(userSettings).values({
      general: { fontSize: 16 },
      id: userId,
      keyVaults: 'encrypted',
    });
    await serverDB.insert(messages).values([
      { content: 'm1', id: 'bundle-m1', role: 'user', userId },
      { content: 'm2', id: 'bundle-m2', role: 'user', userId },
      { content: 'other', id: 'bundle-other', role: 'user', userId: otherUserId },
    ]);
    await serverDB.insert(sessions).values([
      { id: 'bundle-s1', userId },
      { id: 'bundle-s2', userId },
      { id: 'bundle-s-other', userId: otherUserId },
    ]);

    const bundle = await userModel.getUserStateBundle(mockDecryptor);
    const state = await userModel.getUserState(mockDecryptor);

    expect(bundle.state).toEqual(state);
    expect(bundle.state.email).toBe('bundle@example.com');
    expect(bundle.state.settings.general).toEqual({ fontSize: 16 });
    expect(bundle.state.settings.keyVaults).toEqual({ openai: { apiKey: 'sk-test' } });
    expect(bundle.messageCount).toBe(2);
    expect(bundle.hasExtraSession).toBe(true);
  });

  it('caps messageCount at 5 and reports no extra session when only the default exists', async () => {
    await serverDB.insert(messages).values(
      Array.from({ length: 8 }, (_, i) => ({
        content: `m${i}`,
        id: `bundle-cap-${i}`,
        role: 'user' as const,
        userId,
      })),
    );
    await serverDB.insert(sessions).values({ id: 'bundle-only-one', userId });

    const bundle = await userModel.getUserStateBundle(mockDecryptor);

    expect(bundle.messageCount).toBe(5);
    expect(bundle.hasExtraSession).toBe(false);
  });

  it("does not count another user's messages or sessions", async () => {
    await serverDB.insert(messages).values({
      content: 'other',
      id: 'bundle-iso-m',
      role: 'user',
      userId: otherUserId,
    });
    await serverDB.insert(sessions).values([
      { id: 'bundle-iso-s1', userId: otherUserId },
      { id: 'bundle-iso-s2', userId: otherUserId },
    ]);

    const bundle = await userModel.getUserStateBundle(mockDecryptor);

    expect(bundle.messageCount).toBe(0);
    expect(bundle.hasExtraSession).toBe(false);
  });

  it('ignores same-user workspace messages/sessions so personal flags stay off', async () => {
    await serverDB.insert(workspaces).values({
      id: 'bundle-ws',
      name: 'WS',
      primaryOwnerId: userId,
      slug: 'bundle-ws',
    });
    await serverDB.insert(sessions).values([
      { id: 'bundle-ws-s1', userId, workspaceId: 'bundle-ws' },
      { id: 'bundle-ws-s2', userId, workspaceId: 'bundle-ws' },
    ]);
    await serverDB.insert(messages).values(
      Array.from({ length: 6 }, (_, i) => ({
        content: `ws-${i}`,
        id: `bundle-ws-m${i}`,
        role: 'user' as const,
        userId,
        workspaceId: 'bundle-ws',
      })),
    );

    const bundle = await userModel.getUserStateBundle(mockDecryptor);

    // Router: hasConversation = messageCount > 0 || hasExtraSession
    // canEnablePWAGuide / canEnableTrace = messageCount > 4
    expect(bundle.messageCount).toBe(0);
    expect(bundle.hasExtraSession).toBe(false);
  });

  it('throws UserNotFoundError for a missing user', async () => {
    await expect(
      new UserModel(serverDB, 'missing-bundle-user').getUserStateBundle(mockDecryptor),
    ).rejects.toThrow(UserNotFoundError);
  });

  it('keeps getUserState identical when settings are empty', async () => {
    const bundle = await userModel.getUserStateBundle(mockDecryptor);
    const state = await new UserModel(serverDB, userId).getUserState(mockDecryptor);

    expect(bundle.state).toEqual(state);
    expect(bundle.state.settings.defaultAgent).toEqual({});
    expect(bundle.state.settings.market).toBeUndefined();
  });
});
