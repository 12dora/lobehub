import { describe, expect, it, vi } from 'vitest';

import {
  IdentityProviderTestPopupBlockedError,
  isIdentityProviderTestTerminal,
  openIdentityProviderTestPopup,
  parseIdentityProviderJsonObject,
  resolveIdentityProviderRestartPhase,
  resolveIdentityProviderRevisionRefresh,
} from './controller';

describe('identity provider editor controller', () => {
  it('stops polling only for terminal test states', () => {
    expect(isIdentityProviderTestTerminal('pending')).toBe(false);
    expect(isIdentityProviderTestTerminal('processing')).toBe(false);
    expect(isIdentityProviderTestTerminal('succeeded')).toBe(true);
    expect(isIdentityProviderTestTerminal('failed')).toBe(true);
  });

  it('keeps invalid intermediate JSON outside the canonical draft', () => {
    expect(parseIdentityProviderJsonObject('{"group":')).toEqual({ valid: false });
    expect(parseIdentityProviderJsonObject('[]')).toEqual({ valid: false });
    expect(parseIdentityProviderJsonObject('{"group":"admin"}')).toEqual({
      valid: true,
      value: { group: 'admin' },
    });
  });

  it('opens a blank popup synchronously before awaiting the test-start request', async () => {
    const popup = { closed: false, close: vi.fn(), location: { assign: vi.fn() } };
    let resolveStart!: (value: { authorizationUrl: string }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ authorizationUrl: string }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const openWindow = vi.fn(() => popup as unknown as Window);

    const pending = openIdentityProviderTestPopup(start, openWindow as typeof window.open);
    expect(openWindow).toHaveBeenCalledWith(
      'about:blank',
      'oidc-provider-test',
      'width=520,height=720',
    );
    expect(start).toHaveBeenCalledOnce();
    expect(popup.location.assign).not.toHaveBeenCalled();

    resolveStart({ authorizationUrl: 'https://login.example.test/authorize' });
    await expect(pending).resolves.toEqual({
      authorizationUrl: 'https://login.example.test/authorize',
    });
    expect(popup.location.assign).toHaveBeenCalledWith('https://login.example.test/authorize');
  });

  it('reports a blocked popup and closes a blank popup when test-start fails', async () => {
    await expect(
      openIdentityProviderTestPopup(
        async () => ({ authorizationUrl: 'https://example.test' }),
        () => null,
      ),
    ).rejects.toBeInstanceOf(IdentityProviderTestPopupBlockedError);

    const popup = { closed: false, close: vi.fn(), location: { assign: vi.fn() } };
    await expect(
      openIdentityProviderTestPopup(
        async () => {
          throw new Error('network failed');
        },
        () => popup as unknown as Window,
      ),
    ).rejects.toThrow('network failed');
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it('stops restart polling on activation, failure, and unsupported convergence', () => {
    const pending = {
      active: { allFreshInstancesActive: false },
      pendingRestart: true,
      restart: { supported: true },
      targetIdentityRevision: 'a'.repeat(64),
    };
    expect(
      resolveIdentityProviderRestartPhase({ error: null, phase: 'accepted', status: pending }),
    ).toBe('accepted');
    expect(
      resolveIdentityProviderRestartPhase({
        error: null,
        phase: 'accepted',
        status: {
          ...pending,
          active: { allFreshInstancesActive: true },
          pendingRestart: false,
        },
      }),
    ).toBe('activated');
    expect(
      resolveIdentityProviderRestartPhase({
        error: new Error('offline'),
        phase: 'accepted',
      }),
    ).toBe('failed');
    expect(
      resolveIdentityProviderRestartPhase({
        error: new Error('background refresh failed'),
        phase: 'accepted',
        status: pending,
      }),
    ).toBe('accepted');
    expect(
      resolveIdentityProviderRestartPhase({
        error: null,
        phase: 'accepted',
        status: { ...pending, restart: { supported: false } },
      }),
    ).toBe('failed');
  });

  it('preserves a local draft for the conflict refresh and hydrates later revisions', () => {
    expect(
      resolveIdentityProviderRevisionRefresh({
        currentRevision: 3,
        nextRevision: 4,
        preserveDraft: true,
      }),
    ).toBe('preserve');
    expect(
      resolveIdentityProviderRevisionRefresh({
        currentRevision: 4,
        nextRevision: 5,
        preserveDraft: false,
      }),
    ).toBe('hydrate');
    expect(
      resolveIdentityProviderRevisionRefresh({
        currentRevision: 5,
        nextRevision: 5,
        preserveDraft: false,
      }),
    ).toBe('unchanged');
  });
});
