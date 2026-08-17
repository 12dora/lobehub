import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OAuthDeviceFlowAuth from './index';

/**
 * The API-key connect route with the REAL flow hook underneath — only the tRPC calls are
 * mocked.
 *
 * The bug this file exists for could not be seen through a mocked hook: the panel decided
 * whether an envelope was still usable from `deviceCodeInfo`, a render value that outlived
 * every terminal invalidation, while the hook redeems against a ref that does not. A mocked
 * hook agrees with whatever the component believes; a real one does not.
 */
const mocks = vi.hoisted(() => ({
  authStatus: undefined as unknown,
  initiate: vi.fn(),
  invalidate: vi.fn(),
  poll: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));

vi.mock('@/libs/trpc/client', () => ({
  lambdaQuery: {
    oauthDeviceFlow: {
      getAuthStatus: { useQuery: () => ({ data: mocks.authStatus }) },
      initiateDeviceCode: { useMutation: () => ({ mutateAsync: mocks.initiate }) },
      pollAuthStatus: { useMutation: () => ({ mutateAsync: mocks.poll }) },
      revokeAuth: { useMutation: () => ({ isPending: false, mutateAsync: mocks.revoke }) },
    },
    useUtils: () => ({
      oauthDeviceFlow: {
        getAuthStatus: { invalidate: (...args: unknown[]) => mocks.invalidate(...args) },
      },
    }),
  },
}));

vi.mock('react-i18next', () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
  useTranslation: () => ({ t: (key: string) => key }),
}));

const render = (ui: ReactElement) =>
  rtlRender(<MotionProvider motion={motion}>{ui}</MotionProvider>);

/** Cursor's envelope: a device-flow shape with no user code and an API-key paste route. */
const envelope = (deviceCode: string) => ({
  allowAccessTokenPaste: true,
  deviceCode,
  // Long enough that the expiry timer never fires inside a test.
  expiresIn: 3600,
  flow: 'device_code' as const,
  interval: 3600,
  userCode: '',
  verificationUri: 'https://cursor.com/loginDeepControl',
  verificationUriComplete: 'https://cursor.com/loginDeepControl?challenge=abc&uuid=u1',
});

/** A promise the test resolves by hand, so a pending round trip can be inspected. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

/** Only the calls that redeem a key — the polling loop uses the same mutation. */
const exchangeCalls = () =>
  mocks.poll.mock.calls.filter(([input]) =>
    Boolean((input as { accessToken?: string }).accessToken),
  );

const openApiKeyBox = () => {
  fireEvent.click(screen.getByText('providerModels.config.oauth.paste.apiKeyToggle'));
};

const typeKey = (value: string) => {
  fireEvent.change(
    screen.getByPlaceholderText('providerModels.config.oauth.paste.apiKeyPlaceholder'),
    { target: { value } },
  );
};

const submitKey = () => {
  fireEvent.click(screen.getByText('providerModels.config.oauth.paste.apiKeySubmit'));
};

beforeEach(() => {
  mocks.authStatus = undefined;
  mocks.initiate.mockReset();
  mocks.poll.mockReset();
  mocks.invalidate.mockReset();
  mocks.invalidate.mockResolvedValue(undefined);
  mocks.revoke.mockReset();
  vi.stubGlobal('open', vi.fn());
});

describe('OAuthDeviceFlowAuth API-key route (real flow)', () => {
  it('requests a new envelope after the previous exchange reported it expired', async () => {
    mocks.initiate
      .mockResolvedValueOnce(envelope('envelope-1'))
      .mockResolvedValueOnce(envelope('envelope-2'));
    mocks.poll.mockResolvedValueOnce({ status: 'expired' }).mockResolvedValueOnce({
      status: 'success',
    });

    render(<OAuthDeviceFlowAuth name="Cursor" providerId="cursor" />);

    openApiKeyBox();
    typeKey('key_live_first');
    submitKey();

    // The envelope is spent: the flow says so in its own words, and drops it.
    await screen.findByText('providerModels.config.oauth.codeExpired');
    expect(exchangeCalls()).toHaveLength(1);

    // The retry the panel used to swallow: with the stale envelope still rendered, this
    // submit returned without a request of any kind.
    typeKey('key_live_second');
    submitKey();

    await vi.waitFor(() => expect(exchangeCalls()).toHaveLength(2));
    expect(mocks.initiate).toHaveBeenCalledTimes(2);
    expect(exchangeCalls()[1]![0]).toMatchObject({
      accessToken: 'key_live_second',
      deviceCode: 'envelope-2',
    });
    // Stored: the card stops offering the connect routes and reports the connection.
    await screen.findByText('providerModels.config.oauth.connected');
  });

  it('reports a refused envelope as an authorization failure, never as a bad key', async () => {
    mocks.initiate.mockRejectedValueOnce(new Error('offline'));

    render(<OAuthDeviceFlowAuth name="Cursor" providerId="cursor" />);

    openApiKeyBox();
    typeKey('key_live_abc');
    submitKey();

    await screen.findByText('providerModels.config.oauth.authError');
    // The key never reached the server, so nothing about it was judged.
    expect(mocks.poll).not.toHaveBeenCalled();
    expect(screen.queryByText('providerModels.config.oauth.paste.apiKeyError')).toBeNull();
  });

  it('reports a rejected key inside the form, and keeps the flow error off the card', async () => {
    mocks.initiate.mockResolvedValueOnce(envelope('envelope-1'));
    mocks.poll.mockResolvedValueOnce({ error: 'access_token_invalid', status: 'error' });

    render(<OAuthDeviceFlowAuth name="Cursor" providerId="cursor" />);

    openApiKeyBox();
    typeKey('key_live_wrong');
    submitKey();

    await screen.findByText('providerModels.config.oauth.paste.apiKeyError');
    expect(screen.queryByText('providerModels.config.oauth.authError')).toBeNull();
    // A recoverable exchange failure keeps the envelope, so a corrected key reuses it.
    typeKey('key_live_right');
    mocks.poll.mockResolvedValueOnce({ status: 'success' });
    submitKey();

    await vi.waitFor(() => expect(exchangeCalls()).toHaveLength(2));
    expect(mocks.initiate).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending envelope request instead of leaving the box spinning', async () => {
    const pending = deferred<ReturnType<typeof envelope>>();
    mocks.initiate.mockReturnValueOnce(pending.promise);

    render(<OAuthDeviceFlowAuth name="Cursor" providerId="cursor" />);

    openApiKeyBox();
    typeKey('key_live_abc');
    submitKey();

    // While the hidden round trip runs, the browser login stands down and there is a way out.
    await vi.waitFor(() =>
      expect(
        screen
          .getByText('providerModels.config.oauth.connect')
          .closest('button')!
          .hasAttribute('disabled'),
      ).toBe(true),
    );
    fireEvent.click(screen.getByText('providerModels.config.oauth.cancel'));

    pending.resolve(envelope('envelope-late'));
    await vi.waitFor(() =>
      expect(
        screen
          .getByText('providerModels.config.oauth.connect')
          .closest('button')!
          .hasAttribute('disabled'),
      ).toBe(false),
    );
    // The abandoned envelope is never redeemed, and the cancel leaves no error behind.
    expect(mocks.poll).not.toHaveBeenCalled();
    expect(screen.queryByText('providerModels.config.oauth.authError')).toBeNull();
  });

  it('spends one envelope for a key submitted twice in a row', async () => {
    const pending = deferred<ReturnType<typeof envelope>>();
    mocks.initiate.mockReturnValueOnce(pending.promise);
    mocks.poll.mockResolvedValue({ status: 'success' });

    render(<OAuthDeviceFlowAuth name="Cursor" providerId="cursor" />);

    openApiKeyBox();
    typeKey('key_live_abc');
    submitKey();
    submitKey();
    submitKey();

    pending.resolve(envelope('envelope-1'));
    await vi.waitFor(() => expect(exchangeCalls()).toHaveLength(1));
    // A second envelope would have retired the grant the first exchange is redeeming.
    expect(mocks.initiate).toHaveBeenCalledTimes(1);
  });
});
