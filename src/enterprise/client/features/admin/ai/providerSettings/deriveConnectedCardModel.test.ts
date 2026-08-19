import { describe, expect, it } from 'vitest';

import type { SharedOAuthConnectionStatus } from './deriveConnectedCardModel';
import { deriveConnectedCardModel } from './deriveConnectedCardModel';
import { formatExpiry } from './sharedOAuthFormat';

const EXPIRY = String(Date.UTC(2030, 0, 1));
const LAST_REFRESH = String(Date.UTC(2029, 11, 31));

const derive = (
  status: SharedOAuthConnectionStatus | undefined,
  extras: Partial<Parameters<typeof deriveConnectedCardModel>[0]> = {},
) =>
  deriveConnectedCardModel({
    name: 'ChatGPT',
    needsReauth: false,
    webSessionOnly: false,
    ...extras,
    status,
  });

interface DeriveCase {
  expected: Record<string, unknown>;
  name: string;
  needsReauth: boolean;
  status: SharedOAuthConnectionStatus | undefined;
  webSessionOnly: boolean;
}

describe('deriveConnectedCardModel', () => {
  it.each<DeriveCase>([
    {
      expected: { view: 'disconnected' as const },
      name: 'disconnected',
      needsReauth: false,
      status: { connected: false },
      webSessionOnly: false,
    },
    {
      expected: { view: 'disconnected' as const },
      name: 'disconnected with no status',
      needsReauth: false,
      status: undefined,
      webSessionOnly: false,
    },
    {
      expected: {
        account: 'ops@example.com',
        autoRenews: false,
        cannotAutoRenew: false,
        health: 'healthy' as const,
        pasteFlow: false,
        view: 'account' as const,
      },
      name: 'connected+email',
      needsReauth: false,
      status: {
        accountEmail: 'ops@example.com',
        accountIdMasked: 'acc1…',
        connected: true,
      },
      webSessionOnly: false,
    },
    {
      expected: {
        account: 'acc1…',
        health: 'healthy' as const,
        view: 'account' as const,
      },
      name: 'connected+masked id',
      needsReauth: false,
      status: {
        accountEmail: null,
        accountIdMasked: 'acc1…',
        connected: true,
      },
      webSessionOnly: false,
    },
    {
      expected: {
        account: 'ops@example.com',
        health: 'reauth' as const,
        pasteFlow: true,
        view: 'account' as const,
      },
      name: 'needsReauth+pasteFlow',
      needsReauth: true,
      status: {
        accountEmail: 'ops@example.com',
        connected: true,
        flow: 'authorization_code_paste',
      },
      webSessionOnly: true,
    },
    {
      expected: {
        health: 'reauth' as const,
        pasteFlow: false,
        view: 'account' as const,
      },
      name: 'needsReauth+device_code',
      needsReauth: true,
      status: {
        accountEmail: 'ops@example.com',
        connected: true,
        flow: 'device_code',
      },
      webSessionOnly: false,
    },
    {
      expected: {
        cannotAutoRenew: true,
        health: 'cannotRenew' as const,
        view: 'account' as const,
      },
      name: 'cannotRenew+expiry+webSessionOnly',
      needsReauth: false,
      status: {
        canRefresh: false,
        connected: true,
        expiresAt: EXPIRY,
        flow: 'authorization_code_paste',
      },
      webSessionOnly: true,
    },
    {
      expected: {
        cannotAutoRenew: true,
        health: 'cannotRenew' as const,
        view: 'account' as const,
      },
      name: 'cannotRenew+expiry without webSessionOnly',
      needsReauth: false,
      status: {
        canRefresh: false,
        connected: true,
        expiresAt: EXPIRY,
        flow: 'authorization_code_paste',
      },
      webSessionOnly: false,
    },
    {
      expected: {
        cannotAutoRenew: true,
        health: 'cannotRenew' as const,
        view: 'account' as const,
      },
      name: 'cannotRenew without expiry+webSessionOnly',
      needsReauth: false,
      status: {
        canRefresh: false,
        connected: true,
        expiresAt: null,
        flow: 'authorization_code_paste',
      },
      webSessionOnly: true,
    },
    {
      expected: {
        cannotAutoRenew: true,
        health: 'cannotRenew' as const,
        view: 'account' as const,
      },
      name: 'cannotRenew without expiry or webSessionOnly',
      needsReauth: false,
      status: {
        canRefresh: false,
        connected: true,
        expiresAt: null,
        flow: 'authorization_code_paste',
      },
      webSessionOnly: false,
    },
    {
      expected: {
        autoRenews: true,
        cannotAutoRenew: false,
        health: 'healthy' as const,
        pasteFlow: true,
        view: 'account' as const,
      },
      name: 'autoRenews via pasteFlow without renewalKind',
      needsReauth: false,
      status: {
        canRefresh: true,
        connected: true,
        flow: 'authorization_code_paste',
      },
      webSessionOnly: false,
    },
    {
      expected: {
        autoRenews: true,
        cannotAutoRenew: false,
        health: 'healthy' as const,
        pasteFlow: false,
        renewalKind: 'cursor_api_key' as const,
        view: 'account' as const,
      },
      name: 'autoRenews via cursor_api_key on device-code',
      needsReauth: false,
      status: {
        canRefresh: true,
        connected: true,
        flow: 'device_code',
        renewalKind: 'cursor_api_key',
      },
      webSessionOnly: false,
    },
    {
      expected: {
        autoRenews: false,
        cannotAutoRenew: false,
        health: 'healthy' as const,
        pasteFlow: false,
        view: 'account' as const,
      },
      name: 'canRefresh:false on device-code stays healthy, not cannotRenew',
      needsReauth: false,
      status: {
        canRefresh: false,
        connected: true,
        expiresAt: EXPIRY,
        flow: 'device_code',
      },
      webSessionOnly: false,
    },
  ])('$name', ({ expected, needsReauth, status, webSessionOnly }) => {
    expect(derive(status, { needsReauth, webSessionOnly })).toMatchObject(expected);
  });

  it('keeps a dead grant on the account view even when connected is false', () => {
    expect(
      derive(
        { accountEmail: 'ops@example.com', connected: false, flow: 'authorization_code_paste' },
        { needsReauth: true },
      ),
    ).toMatchObject({
      account: 'ops@example.com',
      health: 'reauth',
      view: 'account',
    });
  });

  it('prefers reauth health over cannotRenew when both flags fire', () => {
    expect(
      derive(
        {
          canRefresh: false,
          connected: true,
          flow: 'authorization_code_paste',
        },
        { needsReauth: true },
      ),
    ).toMatchObject({
      cannotAutoRenew: true,
      health: 'reauth',
      view: 'account',
    });
  });

  it('does not treat a silent canRefresh as a dead grant', () => {
    expect(
      derive({
        connected: true,
        flow: 'authorization_code_paste',
      }),
    ).toMatchObject({
      autoRenews: false,
      cannotAutoRenew: false,
      health: 'healthy',
    });
  });

  it('does not treat a device-code refresh token as auto-renewing without renewalKind', () => {
    expect(
      derive({
        canRefresh: true,
        connected: true,
        flow: 'device_code',
      }),
    ).toMatchObject({
      autoRenews: false,
      health: 'healthy',
    });
  });

  it('formats expiry and lastRefresh the same way the card did', () => {
    const model = derive({
      canRefresh: true,
      connected: true,
      expiresAt: EXPIRY,
      flow: 'authorization_code_paste',
      lastRefreshAt: LAST_REFRESH,
      renewalKind: 'web_session',
    });

    expect(model).toMatchObject({
      expiry: formatExpiry(EXPIRY),
      lastRefresh: formatExpiry(LAST_REFRESH),
      renewalKind: 'web_session',
      view: 'account',
    });
  });
});
