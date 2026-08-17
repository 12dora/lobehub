import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOAuthDeviceFlow } from './useOAuthDeviceFlow';

const mocks = vi.hoisted(() => ({
  initiate: vi.fn(),
  poll: vi.fn(),
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaQuery: {
    oauthDeviceFlow: {
      initiateDeviceCode: { useMutation: () => ({ mutateAsync: mocks.initiate }) },
      pollAuthStatus: { useMutation: () => ({ mutateAsync: mocks.poll }) },
    },
  },
}));

const pasteInitiateResponse = {
  allowAccessTokenPaste: true,
  deviceCode: '{"v":1}',
  expiresIn: 600,
  flow: 'authorization_code_paste',
  interval: 0,
  userCode: '',
  verificationUri: 'https://auth.openai.com/api/accounts/authorize?x=1',
  verificationUriComplete: undefined,
};

beforeEach(() => {
  vi.useRealTimers();
  mocks.initiate.mockReset();
  mocks.poll.mockReset();
});

describe('useOAuthDeviceFlow paste flow', () => {
  it('never polls after initiating an authorization-code paste flow', async () => {
    vi.useFakeTimers();
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgptweb' }));

    await act(async () => {
      await result.current.startAuth();
    });

    expect(result.current.deviceCodeInfo?.flow).toBe('authorization_code_paste');
    expect(result.current.deviceCodeInfo?.allowAccessTokenPaste).toBe(true);
    expect(result.current.state).toBe('pending_user_auth');

    // The device-code flow would have started polling 2s in; this one must stay silent.
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(mocks.poll).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('polls a device-code flow after the read-the-code delay', async () => {
    vi.useFakeTimers();
    mocks.initiate.mockResolvedValue({
      allowAccessTokenPaste: false,
      deviceCode: 'dc',
      expiresIn: 600,
      flow: 'device_code',
      interval: 5,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://example.test/device',
    });
    mocks.poll.mockResolvedValue({ status: 'pending' });

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgpt' }));

    await act(async () => {
      await result.current.startAuth();
    });

    expect(result.current.deviceCodeInfo?.flow).toBe('device_code');

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mocks.poll).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('redeems a pasted callback URL against the envelope and reports success', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    mocks.poll.mockResolvedValue({ status: 'success' });
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useOAuthDeviceFlow({ onSuccess, providerId: 'chatgptweb' }),
    );

    await act(async () => {
      await result.current.startAuth();
    });
    await act(async () => {
      await result.current.submitCallback('https://platform.openai.com/auth/callback?code=a');
    });

    expect(mocks.poll).toHaveBeenCalledWith({
      callbackUrl: 'https://platform.openai.com/auth/callback?code=a',
      deviceCode: '{"v":1}',
      providerId: 'chatgptweb',
    });
    expect(result.current.state).toBe('success');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('maps server error literals to recoverable inline errors', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    mocks.poll.mockResolvedValue({ error: 'invalid_callback', status: 'error' });

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgptweb' }));

    await act(async () => {
      await result.current.startAuth();
    });
    await act(async () => {
      await result.current.submitCallback('nonsense');
    });

    expect(result.current.submitError).toBe('invalidCallback');
    // Recoverable: the flow stays open so the user can paste again.
    expect(result.current.state).toBe('pending_user_auth');
  });

  it('treats an expired envelope as terminal so the user regenerates the link', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    mocks.poll.mockResolvedValue({ error: 'expired', status: 'error' });

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgptweb' }));

    await act(async () => {
      await result.current.startAuth();
    });
    await act(async () => {
      await result.current.submitCallback('https://platform.openai.com/auth/callback?code=a');
    });

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error).toBe('codeExpired');
  });

  it('sends a pasted access token instead of a callback URL', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    mocks.poll.mockResolvedValue({ error: 'access_token_invalid', status: 'error' });

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgptweb' }));

    await act(async () => {
      await result.current.startAuth();
    });
    await act(async () => {
      await result.current.submitAccessToken('sk-pasted');
    });

    expect(mocks.poll).toHaveBeenCalledWith({
      accessToken: 'sk-pasted',
      deviceCode: '{"v":1}',
      providerId: 'chatgptweb',
    });
    expect(result.current.submitError).toBe('accessTokenInvalid');
  });

  it('stores a pasted web session as the renewable credential', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    mocks.poll.mockResolvedValue({ status: 'success' });
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useOAuthDeviceFlow({ onSuccess, providerId: 'chatgptweb' }),
    );

    await act(async () => {
      await result.current.startAuth();
    });
    await act(async () => {
      await result.current.submitSessionToken('session-jwe');
    });

    // The session travels in its OWN field: the server stores it as the renewal credential,
    // which is the entire difference between this paste and an access token.
    expect(mocks.poll).toHaveBeenCalledWith({
      deviceCode: '{"v":1}',
      providerId: 'chatgptweb',
      sessionToken: 'session-jwe',
    });
    expect(result.current.state).toBe('success');
    expect(onSuccess).toHaveBeenCalled();
  });

  it.each([
    ['session_invalid', 'sessionInvalid'],
    ['token_not_web', 'tokenNotWeb'],
  ])('maps the %s literal onto the pasted-credential field', async (code, mapped) => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    mocks.poll.mockResolvedValue({ error: code, status: 'error' });

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgptweb' }));

    await act(async () => {
      await result.current.startAuth();
    });
    await act(async () => {
      await result.current.submitSessionToken('session-jwe');
    });

    expect(result.current.submitError).toBe(mapped);
    // A session submit is a token-field submit, so the error lands on the box that produced it.
    expect(result.current.submitErrorSource).toBe('token');
    // Recoverable: the form stays open so the user can paste a fresh session in place.
    expect(result.current.state).toBe('pending_user_auth');
  });

  it('reports a rejected request as a recoverable error, not a dead flow', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    mocks.poll.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgptweb' }));

    await act(async () => {
      await result.current.startAuth();
    });
    await act(async () => {
      await result.current.submitCallback('https://platform.openai.com/auth/callback?code=a');
    });

    expect(result.current.submitError).toBe('authError');
    expect(result.current.submitting).toBe(false);
  });

  it('keeps the submitted field with a generic failure so the form can point at it', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    mocks.poll.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgptweb' }));

    await act(async () => {
      await result.current.startAuth();
    });
    await act(async () => {
      await result.current.submitAccessToken('sk-pasted');
    });

    // `authError` names no field of its own — only the source says it was the token box.
    expect(result.current.submitError).toBe('authError');
    expect(result.current.submitErrorSource).toBe('token');

    await act(async () => {
      await result.current.submitCallback('https://platform.openai.com/auth/callback?code=a');
    });
    expect(result.current.submitErrorSource).toBe('callback');
  });
});

/** A promise the test resolves by hand, to hold a network step open across a lifecycle event. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const deviceCodeInitiateResponse = {
  allowAccessTokenPaste: false,
  deviceCode: 'dc-1',
  expiresIn: 600,
  flow: 'device_code',
  interval: 5,
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://example.test/device',
};

describe('useOAuthDeviceFlow run lifecycle', () => {
  it('arms nothing when initiation resolves after unmount', async () => {
    vi.useFakeTimers();
    const pending = deferred<typeof deviceCodeInitiateResponse>();
    mocks.initiate.mockReturnValue(pending.promise);
    mocks.poll.mockResolvedValue({ status: 'pending' });

    const { result, unmount } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgpt' }));

    let started: Promise<unknown> | undefined;
    act(() => {
      started = result.current.startAuth();
    });

    unmount();

    await act(async () => {
      pending.resolve(deviceCodeInitiateResponse);
      await started;
    });

    // Neither the expiry timer nor the polling loop may come back from the dead.
    await act(async () => {
      vi.advanceTimersByTime(700_000);
    });
    expect(mocks.poll).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('drops the polling start delay when the hook unmounts inside it', async () => {
    vi.useFakeTimers();
    mocks.initiate.mockResolvedValue(deviceCodeInitiateResponse);
    mocks.poll.mockResolvedValue({ status: 'pending' });

    const { result, unmount } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgpt' }));

    await act(async () => {
      await result.current.startAuth();
    });

    // Inside the 2s "read the code first" window.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(mocks.poll).not.toHaveBeenCalled();

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(mocks.poll).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('lets a regenerated envelope outlive the previous expiry timer', async () => {
    vi.useFakeTimers();
    mocks.initiate
      .mockResolvedValueOnce({ ...pasteInitiateResponse, deviceCode: 'first', expiresIn: 1 })
      .mockResolvedValueOnce({ ...pasteInitiateResponse, deviceCode: 'second', expiresIn: 600 });

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgptweb' }));

    await act(async () => {
      await result.current.startAuth();
    });
    // Regenerate before the first envelope expires.
    await act(async () => {
      await result.current.startAuth();
    });

    expect(result.current.deviceCodeInfo?.deviceCode).toBe('second');

    // The first envelope's 1s expiry now fires — it must not kill the run that replaced it.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.state).toBe('pending_user_auth');
    expect(result.current.error).toBeUndefined();
    vi.useRealTimers();
  });

  it('ignores a paste submission that completes after cancel', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    const pending = deferred<{ status: string }>();
    mocks.poll.mockReturnValue(pending.promise);
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useOAuthDeviceFlow({ onSuccess, providerId: 'chatgptweb' }),
    );

    await act(async () => {
      await result.current.startAuth();
    });

    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = result.current.submitCallback('https://platform.openai.com/auth/callback?code=a');
    });

    act(() => {
      result.current.cancelAuth();
    });

    await act(async () => {
      pending.resolve({ status: 'success' });
      await submitted;
    });

    // The user asked for this flow to stop; a late success must not resurrect it.
    expect(result.current.state).toBe('idle');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.submitting).toBe(false);
  });

  it('redeems the single-use grant once even when the button is clicked twice', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    const pending = deferred<{ status: string }>();
    mocks.poll.mockReturnValue(pending.promise);

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'chatgptweb' }));

    await act(async () => {
      await result.current.startAuth();
    });

    // Two calls from the SAME render: a React-state guard cannot see the first one yet.
    let both: Promise<unknown> | undefined;
    act(() => {
      both = Promise.all([
        result.current.submitCallback('https://platform.openai.com/auth/callback?code=a'),
        result.current.submitCallback('https://platform.openai.com/auth/callback?code=a'),
      ]);
    });

    expect(mocks.poll).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ status: 'success' });
      await both;
    });
    expect(result.current.state).toBe('success');
  });
});

describe('useOAuthDeviceFlow stale reconciliation', () => {
  it('re-reads the status when a paste submission succeeds after cancel', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    const pending = deferred<{ status: string }>();
    mocks.poll.mockReturnValue(pending.promise);
    const onStatusStale = vi.fn();
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useOAuthDeviceFlow({ onStatusStale, onSuccess, providerId: 'chatgptweb' }),
    );

    await act(async () => {
      await result.current.startAuth();
    });

    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = result.current.submitCallback('https://platform.openai.com/auth/callback?code=a');
    });
    act(() => {
      result.current.cancelAuth();
    });

    await act(async () => {
      pending.resolve({ status: 'success' });
      await submitted;
    });

    // The credential IS stored: the abandoned run must not own the UI, but the card cannot
    // keep claiming "not connected" either.
    expect(onStatusStale).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });

  it('re-reads the status when a session submission succeeds after cancel', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    const pending = deferred<{ status: string }>();
    mocks.poll.mockReturnValue(pending.promise);
    const onStatusStale = vi.fn();
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useOAuthDeviceFlow({ onStatusStale, onSuccess, providerId: 'chatgptweb' }),
    );

    await act(async () => {
      await result.current.startAuth();
    });

    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = result.current.submitSessionToken('session-jwe');
    });
    act(() => {
      result.current.cancelAuth();
    });

    await act(async () => {
      pending.resolve({ status: 'success' });
      await submitted;
    });

    // The session IS stored server-side: the abandoned run must not own the UI, but the card
    // cannot keep claiming "not connected" either.
    expect(onStatusStale).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
    expect(result.current.submitting).toBe(false);
  });

  it('re-reads the status when a paste submission succeeds after a regenerate', async () => {
    mocks.initiate
      .mockResolvedValueOnce(pasteInitiateResponse)
      .mockResolvedValueOnce({ ...pasteInitiateResponse, deviceCode: '{"v":2}' });
    const pending = deferred<{ status: string }>();
    mocks.poll.mockReturnValue(pending.promise);
    const onStatusStale = vi.fn();

    const { result } = renderHook(() =>
      useOAuthDeviceFlow({ onStatusStale, providerId: 'chatgptweb' }),
    );

    await act(async () => {
      await result.current.startAuth();
    });

    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = result.current.submitCallback('https://platform.openai.com/auth/callback?code=a');
    });
    // Regenerate replaces the envelope while the redemption is still in flight.
    await act(async () => {
      await result.current.startAuth();
    });

    await act(async () => {
      pending.resolve({ status: 'success' });
      await submitted;
    });

    expect(onStatusStale).toHaveBeenCalledTimes(1);
    // The fresh run keeps its own screen; the late success never replaces it.
    expect(result.current.state).toBe('pending_user_auth');
    expect(result.current.deviceCodeInfo?.deviceCode).toBe('{"v":2}');
  });

  it('re-reads the status when a device poll succeeds after cancel', async () => {
    vi.useFakeTimers();
    mocks.initiate.mockResolvedValue(deviceCodeInitiateResponse);
    const pending = deferred<{ status: string }>();
    mocks.poll.mockReturnValue(pending.promise);
    const onStatusStale = vi.fn();
    const onSuccess = vi.fn();

    const { result } = renderHook(() =>
      useOAuthDeviceFlow({ onStatusStale, onSuccess, providerId: 'chatgpt' }),
    );

    await act(async () => {
      await result.current.startAuth();
    });
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(mocks.poll).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.cancelAuth();
    });

    await act(async () => {
      pending.resolve({ status: 'success' });
      await Promise.resolve();
    });

    expect(onStatusStale).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
    vi.useRealTimers();
  });

  it('never calls back after unmount, however the run resolves', async () => {
    mocks.initiate.mockResolvedValue(pasteInitiateResponse);
    const pending = deferred<{ status: string }>();
    mocks.poll.mockReturnValue(pending.promise);
    const onStatusStale = vi.fn();
    const onSuccess = vi.fn();

    const { result, unmount } = renderHook(() =>
      useOAuthDeviceFlow({ onStatusStale, onSuccess, providerId: 'chatgptweb' }),
    );

    await act(async () => {
      await result.current.startAuth();
    });

    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = result.current.submitCallback('https://platform.openai.com/auth/callback?code=a');
    });

    unmount();

    await act(async () => {
      pending.resolve({ status: 'success' });
      await submitted;
    });

    // There is no card left to correct, and the next mount reads the status anyway.
    expect(onStatusStale).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

/**
 * The API-key connect route. It owns both halves of the round trip — envelope, then exchange —
 * because envelope liveness is a REF reading: expiry, denial and a terminal poll all retire the
 * envelope while the rendered `deviceCodeInfo` a caller would consult still describes it.
 */
describe('useOAuthDeviceFlow API-key route', () => {
  /** Cursor's envelope: a device-flow shape whose paste route takes a dashboard key. */
  const apiKeyEnvelope = (deviceCode: string) => ({
    allowAccessTokenPaste: true,
    deviceCode,
    expiresIn: 3600,
    flow: 'device_code',
    interval: 3600,
    userCode: '',
    verificationUri: 'https://cursor.com/loginDeepControl',
    verificationUriComplete: 'https://cursor.com/loginDeepControl?challenge=abc',
  });

  const exchangeCalls = () => mocks.poll.mock.calls.filter(([input]) => Boolean(input.accessToken));

  it('requests an envelope, exchanges the key, and reports both phases', async () => {
    const pendingEnvelope = deferred<ReturnType<typeof apiKeyEnvelope>>();
    const pendingExchange = deferred<{ status: string }>();
    mocks.initiate.mockReturnValue(pendingEnvelope.promise);
    mocks.poll.mockReturnValue(pendingExchange.promise);
    const onSuccess = vi.fn();

    const { result } = renderHook(() => useOAuthDeviceFlow({ onSuccess, providerId: 'cursor' }));

    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = result.current.submitApiKey('key_live_abc');
    });

    // The two halves fail for different reasons, so they are two phases, not one spinner.
    expect(result.current.apiKeyPhase).toBe('requestingEnvelope');

    await act(async () => {
      pendingEnvelope.resolve(apiKeyEnvelope('envelope-1'));
      await Promise.resolve();
    });
    expect(result.current.apiKeyPhase).toBe('exchangingKey');

    await act(async () => {
      pendingExchange.resolve({ status: 'success' });
      await submitted;
    });
    expect(result.current.apiKeyPhase).toBe('idle');
    expect(exchangeCalls()[0]![0]).toMatchObject({
      accessToken: 'key_live_abc',
      deviceCode: 'envelope-1',
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('replaces an envelope a terminal poll already spent', async () => {
    vi.useFakeTimers();
    mocks.initiate
      .mockResolvedValueOnce(apiKeyEnvelope('envelope-1'))
      .mockResolvedValueOnce(apiKeyEnvelope('envelope-2'));
    // The browser login was denied: the run is dead and its envelope with it.
    mocks.poll.mockResolvedValueOnce({ status: 'denied' });

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'cursor' }));

    await act(async () => {
      await result.current.startAuth();
    });
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.state).toBe('error');
    // The rendered envelope goes with the ref — nothing may keep offering a spent device code.
    expect(result.current.deviceCodeInfo).toBeUndefined();

    vi.useRealTimers();
    mocks.poll.mockResolvedValueOnce({ status: 'success' });
    await act(async () => {
      await result.current.submitApiKey('key_live_abc');
    });

    // The submit used to return silently here: the ref was empty, so nothing was sent at all.
    expect(mocks.initiate).toHaveBeenCalledTimes(2);
    expect(exchangeCalls()[0]![0]).toMatchObject({ deviceCode: 'envelope-2' });
    expect(result.current.state).toBe('success');
  });

  it('reuses a live envelope instead of discarding the device code in flight', async () => {
    mocks.initiate.mockResolvedValue(apiKeyEnvelope('envelope-1'));
    mocks.poll.mockResolvedValue({ status: 'success' });

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'cursor' }));

    await act(async () => {
      await result.current.startAuth();
    });
    await act(async () => {
      await result.current.submitApiKey('key_live_abc');
    });

    expect(mocks.initiate).toHaveBeenCalledTimes(1);
    expect(exchangeCalls()[0]![0]).toMatchObject({ deviceCode: 'envelope-1' });
  });

  it('leaves an envelope failure on the flow, with nothing said about the key', async () => {
    mocks.initiate.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'cursor' }));

    await act(async () => {
      await result.current.submitApiKey('key_live_abc');
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toBe('authError');
    // The exchange never happened, so no verdict on the key exists to report.
    expect(mocks.poll).not.toHaveBeenCalled();
    expect(result.current.submitError).toBeUndefined();
    expect(result.current.apiKeyPhase).toBe('idle');
  });

  it('spends one envelope for a key submitted twice from the same render', async () => {
    const pendingEnvelope = deferred<ReturnType<typeof apiKeyEnvelope>>();
    mocks.initiate.mockReturnValue(pendingEnvelope.promise);
    mocks.poll.mockResolvedValue({ status: 'success' });

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'cursor' }));

    let both: Promise<unknown> | undefined;
    act(() => {
      both = Promise.all([
        result.current.submitApiKey('key_live_abc'),
        result.current.submitApiKey('key_live_abc'),
      ]);
    });

    await act(async () => {
      pendingEnvelope.resolve(apiKeyEnvelope('envelope-1'));
      await both;
    });

    // A second envelope would have retired the grant the first exchange is redeeming.
    expect(mocks.initiate).toHaveBeenCalledTimes(1);
    expect(exchangeCalls()).toHaveLength(1);
  });

  it('abandons a cancelled attempt without redeeming the envelope it was waiting for', async () => {
    const pendingEnvelope = deferred<ReturnType<typeof apiKeyEnvelope>>();
    mocks.initiate.mockReturnValue(pendingEnvelope.promise);

    const { result } = renderHook(() => useOAuthDeviceFlow({ providerId: 'cursor' }));

    let submitted: Promise<void> | undefined;
    act(() => {
      submitted = result.current.submitApiKey('key_live_abc');
    });
    act(() => {
      result.current.cancelAuth();
    });
    expect(result.current.apiKeyPhase).toBe('idle');

    await act(async () => {
      pendingEnvelope.resolve(apiKeyEnvelope('envelope-late'));
      await submitted;
    });

    // The user asked for this to stop: the late envelope is dropped, not redeemed.
    expect(mocks.poll).not.toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
    expect(result.current.apiKeyPhase).toBe('idle');
  });
});
