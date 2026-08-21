import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUserStore } from '@/store/user';

import UserUpdater, { EMPTY_SESSION_RETRY_MS, resolveIsSignedIn } from './UserUpdater';

const useSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/libs/better-auth/auth-client', () => ({
  useSession: useSessionMock,
}));

const sampleSession = (overrides?: Record<string, unknown>) => ({
  data: {
    user: {
      id: 'u1',
      email: 'a@b.com',
      name: 'Alice',
      username: 'alice',
      ...overrides,
    },
  },
  isPending: false,
  error: null,
});

describe('resolveIsSignedIn', () => {
  it('holds signed-in on an empty body until the retry is confirmed', () => {
    expect(
      resolveIsSignedIn({
        emptySessionConfirmed: false,
        error: null,
        hasUser: false,
        prevIsSignedIn: true,
      }),
    ).toBe(true);
    expect(
      resolveIsSignedIn({
        emptySessionConfirmed: true,
        error: null,
        hasUser: false,
        prevIsSignedIn: true,
      }),
    ).toBe(false);
  });
});

describe('UserUpdater', () => {
  beforeEach(() => {
    useSessionMock.mockReset();
    useUserStore.setState({ user: undefined, isSignedIn: false, isLoaded: false });
  });

  afterEach(() => {
    vi.useRealTimers();
    useUserStore.setState({ user: undefined, isSignedIn: false, isLoaded: false });
  });

  it('preserves user fields populated by useInitUserState (e.g. interests) when better-auth re-emits the session on tab focus', () => {
    // Simulate the post-init state: useInitUserState has loaded interests etc.
    useUserStore.setState({
      user: {
        id: 'u1',
        email: 'a@b.com',
        fullName: 'Alice',
        username: 'alice',
        interests: ['内容创作', '编程'],
        firstName: 'A',
        latestName: 'lice',
      },
    });

    useSessionMock.mockReturnValue(sampleSession());
    const { rerender } = render(<UserUpdater />);

    expect(useUserStore.getState().user?.interests).toEqual(['内容创作', '编程']);
    expect(useUserStore.getState().user?.firstName).toBe('A');

    // Simulate better-auth refetching on visibilitychange: same logical user,
    // but `data` (and therefore `user`) is a fresh object reference.
    useSessionMock.mockReturnValue(sampleSession());
    rerender(<UserUpdater />);

    // Regression: interests / firstName / latestName must NOT be wiped by the
    // session sync. (— wiped interests caused the home daily-brief
    // recommendation SWR key to reset and refetch with empty interestKeys.)
    expect(useUserStore.getState().user?.interests).toEqual(['内容创作', '编程']);
    expect(useUserStore.getState().user?.firstName).toBe('A');
    expect(useUserStore.getState().user?.latestName).toBe('lice');
  });

  it('drops the previous user profile fields when the session switches to a different account', () => {
    // Simulate user A is signed in with profile fields populated.
    useUserStore.setState({
      user: {
        id: 'userA',
        email: 'a@b.com',
        fullName: 'Alice',
        username: 'alice',
        avatar: 'avatar-a',
        interests: ['内容创作', '编程'],
        firstName: 'A',
        latestName: 'lice',
      },
    });

    // Better-Auth refetch returns a different account directly (e.g. another
    // tab signed in as user B with the same cookie jar). No intermediate
    // signed-out state here.
    useSessionMock.mockReturnValue(
      sampleSession({ id: 'userB', email: 'b@c.com', name: 'Bob', username: 'bob' }),
    );
    render(<UserUpdater />);

    // Profile fields tied to user A must NOT leak to user B's store entry.
    const user = useUserStore.getState().user;
    expect(user?.id).toBe('userB');
    expect(user?.email).toBe('b@c.com');
    expect(user?.interests).toBeUndefined();
    expect(user?.firstName).toBeUndefined();
    expect(user?.latestName).toBeUndefined();
    expect(user?.avatar).toBe('');
  });

  it('clears the user when the session goes away', () => {
    useUserStore.setState({
      user: { id: 'u1', email: 'a@b.com', interests: ['x'] },
    });

    useSessionMock.mockReturnValue({ data: null, isPending: false, error: null });
    render(<UserUpdater />);

    expect(useUserStore.getState().user).toBeUndefined();
  });

  describe('transient session-fetch errors', () => {
    it('signs in on an authoritative session with a user', () => {
      useSessionMock.mockReturnValue(sampleSession());
      render(<UserUpdater />);

      expect(useUserStore.getState().isSignedIn).toBe(true);
      expect(useUserStore.getState().isLoaded).toBe(true);
    });

    it('holds signed-in on an empty session until one retry confirms it', async () => {
      vi.useFakeTimers();
      const refetch = vi.fn().mockResolvedValue(undefined);
      useUserStore.setState({ isSignedIn: true, user: { id: 'u1', email: 'a@b.com' } });

      useSessionMock.mockReturnValue({ data: null, error: null, isPending: false, refetch });
      render(<UserUpdater />);

      expect(useUserStore.getState().isSignedIn).toBe(true);
      expect(useUserStore.getState().user?.id).toBe('u1');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(EMPTY_SESSION_RETRY_MS);
      });

      expect(refetch).toHaveBeenCalledOnce();
      expect(useUserStore.getState().isSignedIn).toBe(false);
      expect(useUserStore.getState().user).toBeUndefined();
      vi.useRealTimers();
    });

    it('confirms sign-out after refetch flips isPending false → true → false and does not retry again', async () => {
      vi.useFakeTimers();
      useUserStore.setState({ isSignedIn: true, user: { id: 'u1', email: 'a@b.com' } });

      const refetch = vi.fn();
      const emptySettled = { data: null, error: null, isPending: false, refetch };
      useSessionMock.mockReturnValue(emptySettled);

      const { rerender } = render(<UserUpdater />);
      expect(useUserStore.getState().isSignedIn).toBe(true);

      refetch.mockImplementation(async () => {
        useSessionMock.mockReturnValue({ data: null, error: null, isPending: true, refetch });
        rerender(<UserUpdater />);
        expect(useUserStore.getState().isSignedIn).toBe(true);

        useSessionMock.mockReturnValue(emptySettled);
        rerender(<UserUpdater />);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(EMPTY_SESSION_RETRY_MS);
      });

      expect(refetch).toHaveBeenCalledOnce();
      expect(useUserStore.getState().isSignedIn).toBe(false);
      expect(useUserStore.getState().user).toBeUndefined();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(EMPTY_SESSION_RETRY_MS * 3);
      });
      expect(refetch).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });

    it('signs out immediately on an empty session when the user was already signed out', () => {
      useSessionMock.mockReturnValue({ data: null, error: null, isPending: false });
      render(<UserUpdater />);

      expect(useUserStore.getState().isSignedIn).toBe(false);
    });

    it('signs out on a definitive 401 response', () => {
      useUserStore.setState({ isSignedIn: true, user: { id: 'u1', email: 'a@b.com' } });

      useSessionMock.mockReturnValue({
        data: null,
        error: { status: 401, statusText: 'Unauthorized' },
        isPending: false,
      });
      render(<UserUpdater />);

      expect(useUserStore.getState().isSignedIn).toBe(false);
      expect(useUserStore.getState().user).toBeUndefined();
    });

    it('holds the signed-in state on a 5xx error instead of bouncing to signed-out', () => {
      useUserStore.setState({
        isSignedIn: true,
        user: { id: 'u1', email: 'a@b.com', interests: ['x'] },
      });

      // e.g. server restarting: refetch fails with 500 and no session data
      useSessionMock.mockReturnValue({
        data: null,
        error: { status: 500, statusText: 'Internal Server Error' },
        isPending: false,
      });
      render(<UserUpdater />);

      expect(useUserStore.getState().isSignedIn).toBe(true);
      // profile must also survive the transient error
      expect(useUserStore.getState().user?.id).toBe('u1');
      expect(useUserStore.getState().user?.interests).toEqual(['x']);
    });

    it('holds the signed-in state on a network failure (error without status)', () => {
      useUserStore.setState({ isSignedIn: true, user: { id: 'u1', email: 'a@b.com' } });

      // better-auth's query .catch() path surfaces the raw fetch error (no status)
      useSessionMock.mockReturnValue({
        data: null,
        error: new TypeError('Failed to fetch'),
        isPending: false,
      });
      render(<UserUpdater />);

      expect(useUserStore.getState().isSignedIn).toBe(true);
      expect(useUserStore.getState().user?.id).toBe('u1');
    });

    it('stays signed in when better-auth preserves stale session data alongside a non-401 error', () => {
      useUserStore.setState({ isSignedIn: true });

      useSessionMock.mockReturnValue({
        ...sampleSession(),
        error: { status: 503, statusText: 'Service Unavailable' },
      });
      render(<UserUpdater />);

      expect(useUserStore.getState().isSignedIn).toBe(true);
      expect(useUserStore.getState().user?.id).toBe('u1');
    });

    it('does not assert signed-in from a transient error when the user was signed out', () => {
      useSessionMock.mockReturnValue({
        data: null,
        error: { status: 500, statusText: 'Internal Server Error' },
        isPending: false,
      });
      render(<UserUpdater />);

      expect(useUserStore.getState().isSignedIn).toBe(false);
    });

    it('recovers to signed-in when an authoritative session follows a transient error', () => {
      useUserStore.setState({ isSignedIn: true, user: { id: 'u1', email: 'a@b.com' } });

      useSessionMock.mockReturnValue({
        data: null,
        error: { status: 500, statusText: 'Internal Server Error' },
        isPending: false,
      });
      const { rerender } = render(<UserUpdater />);
      expect(useUserStore.getState().isSignedIn).toBe(true);

      useSessionMock.mockReturnValue(sampleSession());
      rerender(<UserUpdater />);

      expect(useUserStore.getState().isSignedIn).toBe(true);
      expect(useUserStore.getState().user?.id).toBe('u1');
    });
  });
});
