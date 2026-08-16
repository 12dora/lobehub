/**
 * Autosave: persist non-secret fields on step change; never call update when clean;
 * create stays in the wizard and adopts `{id, revision}`.
 *
 * @vitest-environment happy-dom
 */
import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIdentityProviderDraftFromTemplate } from './controller';
import IdentityProviderWizard from './IdentityProviderWizard';
import { IdentityProviderWizardModalContent } from './openIdentityProviderWizardModal';
import {
  IDENTITY_PROVIDER_AUTOSAVE_DEBOUNCE_MS,
  type IdentityProviderPersistResult,
  resolveIdentityProviderWizardClose,
} from './persist';

const serviceMocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; time?: string }) =>
      options?.time ? `${key}:${options.time}` : (options?.defaultValue ?? key),
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
  keyframes: () => '',
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ description }: { description?: ReactNode }) => <div role="alert">{description}</div>,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
    <span data-tooltip={String(title ?? '')}>{children}</span>
  ),
  copyToClipboard: vi.fn(),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    loading,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    loading?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled || loading} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  confirmModal: vi.fn(),
  createModal: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
  useModalContext: () => ({ close: vi.fn() }),
}));

vi.mock('lucide-react', () => ({
  AlertCircle: () => null,
  Ban: () => null,
  Check: () => null,
  CheckCircle2: () => null,
  Clock3: () => null,
  FileText: () => null,
  createLucideIcon: () => () => null,
}));

vi.mock('@/enterprise/client/services/adminIdentityProviders', () => ({
  adminIdentityProvidersService: {
    create: (...args: unknown[]) => serviceMocks.create(...args),
    publish: vi.fn(),
    testStart: vi.fn(),
    update: (...args: unknown[]) => serviceMocks.update(...args),
  },
}));

vi.mock('../users/modals/openReasonModal', () => ({
  openReasonModal: vi.fn(),
}));

vi.mock('./useIdentityProviders', () => ({
  useIdentityProviderCallbacks: () => ({ data: undefined }),
  useIdentityProviderTestResult: () => ({
    data: null,
    error: undefined,
    mutate: vi.fn(),
  }),
  useIdentityProviders: () => ({
    data: { items: [], nextCursor: null },
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
}));

vi.mock('./useUnsavedIdentityProviderGuard', () => ({
  useUnsavedIdentityProviderGuard: () => undefined,
}));

vi.mock('./steps', () => ({
  BasicStep: ({
    draft,
    patch,
  }: {
    draft: { displayName: string; providerKey: string };
    patch: (key: 'displayName' | 'providerKey', value: string) => void;
  }) => (
    <div data-testid="step-basic">
      <input
        aria-label="displayName"
        value={draft.displayName}
        onChange={(event) => patch('displayName', event.target.value)}
      />
      <input
        aria-label="providerKey"
        value={draft.providerKey}
        onChange={(event) => patch('providerKey', event.target.value)}
      />
    </div>
  ),
  ClaimsStep: () => <div data-testid="step-claims" />,
  ClientStep: ({ secret, setSecret }: { secret: string; setSecret: (value: string) => void }) => (
    <div data-testid="step-client">
      <input
        aria-label="clientSecret"
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
      />
    </div>
  ),
  DiscoveryStep: () => <div data-testid="step-discovery" />,
  PolicyStep: () => <div data-testid="step-policy" />,
  PublishStep: () => <div data-testid="step-publish" />,
}));

const createdProvider: PlatformIdentityProviderDraft = {
  activationRevision: null,
  autoProvision: true,
  buttonLabel: 'Sign in with work',
  claimMapping: {
    dingtalkTitle: [],
    dingtalkUserId: [],
    email: ['email'],
    name: ['name', 'preferred_username'],
    picture: ['picture'],
    subject: ['sub'],
  },
  clientId: null,
  dingtalkAllowedCorps: [],
  displayName: 'Work SSO',
  domainAllowlist: [],
  enabled: false,
  groupRoleMapping: {},
  icon: null,
  id: 'idp-created',
  issuer: null,
  migrationRequired: false,
  providerKey: 'work-sso',
  revision: 0,
  scopes: ['openid', 'profile', 'email'],
  secret: { configured: false, updatedAt: null },
  status: 'draft',
  type: 'generic_oidc',
  usePkce: true,
};

const existingProvider: PlatformIdentityProviderDraft = {
  ...createdProvider,
  clientId: 'client-1',
  id: 'idp-existing',
  issuer: 'https://idp.example.test/',
  revision: 4,
  secret: { configured: true, updatedAt: new Date('2026-01-01T00:00:00.000Z') },
};

describe('IdentityProviderWizard autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    serviceMocks.create.mockResolvedValue(createdProvider);
    serviceMocks.update.mockImplementation(async (input: { expectedRevision: number }) => ({
      ...existingProvider,
      revision: input.expectedRevision + 1,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates on the first step change and keeps the wizard open with the returned id', async () => {
    const onSaved = vi.fn().mockResolvedValue(undefined);

    render(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        createSeed={createIdentityProviderDraftFromTemplate('generic_oidc')}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText('displayName'), { target: { value: 'Work SSO' } });
    fireEvent.change(screen.getByLabelText('providerKey'), { target: { value: 'work-sso' } });

    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.discovery/));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDENTITY_PROVIDER_AUTOSAVE_DEBOUNCE_MS);
    });

    expect(serviceMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: null,
        displayName: 'Work SSO',
        issuer: null,
        providerKey: 'work-sso',
        secret: { operation: 'clear' },
      }),
    );
    expect(serviceMocks.update).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'idp-created', revision: 0 }),
    );
    expect(screen.getByTestId('identity-provider-wizard')).toBeTruthy();
    expect(screen.getByTestId('step-discovery')).toBeTruthy();
  });

  it('does not call update when navigating steps on a clean form', async () => {
    render(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={existingProvider}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.publish/));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDENTITY_PROVIDER_AUTOSAVE_DEBOUNCE_MS);
    });

    expect(serviceMocks.update).not.toHaveBeenCalled();
    expect(serviceMocks.create).not.toHaveBeenCalled();
  });

  it('does not call update when explicit Save is clicked on a clean form', async () => {
    render(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={existingProvider}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('identityProviders.actions.save'));
    });

    expect(serviceMocks.update).not.toHaveBeenCalled();
  });

  it('flushes a silent persist without sending a typed secret', async () => {
    const persistRef = { current: null as null | (() => Promise<IdentityProviderPersistResult>) };

    render(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        persistRef={persistRef}
        provider={existingProvider}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('displayName'), { target: { value: 'Renamed' } });
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.client/));
    });
    fireEvent.change(screen.getByLabelText('clientSecret'), { target: { value: 'typed-secret' } });

    await act(async () => {
      await persistRef.current?.();
    });

    expect(serviceMocks.update).toHaveBeenCalledTimes(1);
    expect(serviceMocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Renamed',
        secret: { operation: 'keep' },
      }),
    );
    expect(JSON.stringify(serviceMocks.update.mock.calls[0])).not.toContain('typed-secret');
  });

  it('does not persist when only a typed secret is dirty', async () => {
    const persistRef = { current: null as null | (() => Promise<IdentityProviderPersistResult>) };

    render(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        persistRef={persistRef}
        provider={existingProvider}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.client/));
    });
    fireEvent.change(screen.getByLabelText('clientSecret'), { target: { value: 'typed-secret' } });

    await act(async () => {
      const result = await persistRef.current?.();
      expect(result).toBe('clean');
    });

    expect(serviceMocks.update).not.toHaveBeenCalled();
  });

  it('serialises a deferred autosave and an immediate explicit Save onto incrementing revisions', async () => {
    let release!: (value: PlatformIdentityProviderDraft) => void;
    serviceMocks.update.mockReset();
    serviceMocks.update
      .mockImplementationOnce(
        () =>
          new Promise<PlatformIdentityProviderDraft>((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementation(async (input: { expectedRevision: number }) => ({
        ...existingProvider,
        revision: input.expectedRevision + 1,
      }));

    render(
      <IdentityProviderWizard
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        provider={existingProvider}
        onDirtyChange={vi.fn()}
        onDiscard={vi.fn()}
        onRefresh={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('displayName'), { target: { value: 'Edited once' } });
    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.discovery/));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDENTITY_PROVIDER_AUTOSAVE_DEBOUNCE_MS);
    });
    expect(serviceMocks.update).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByText('identityProviders.actions.save'));
    });
    expect(serviceMocks.update).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ ...existingProvider, displayName: 'Edited once', revision: 5 });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(serviceMocks.update.mock.calls.map((call) => call[0].expectedRevision)).toEqual([4, 5]);
  });
});

describe('identity provider wizard modal close', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    serviceMocks.update.mockImplementation(async (input: { expectedRevision: number }) => ({
      ...existingProvider,
      revision: input.expectedRevision + 1,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes after a dirty persist when no secret remains', async () => {
    const persistRef = {
      current: null as null | (() => Promise<'blocked' | 'clean' | 'conflict' | 'error' | 'saved'>),
    };
    const secretDirtyRef = { current: false };
    const dirtyRef = { current: false };

    render(
      <IdentityProviderWizardModalContent
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        dirtyRef={dirtyRef}
        persistRef={persistRef}
        provider={existingProvider}
        secretDirtyRef={secretDirtyRef}
        onChanged={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('displayName'), { target: { value: 'Closed name' } });
    expect(dirtyRef.current).toBe(true);

    let persistResult: 'blocked' | 'clean' | 'conflict' | 'error' | 'saved' = 'blocked';
    await act(async () => {
      persistResult = (await persistRef.current?.()) ?? 'blocked';
    });
    expect(persistResult).toBe('saved');
    expect(serviceMocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ secret: { operation: 'keep' } }),
    );
    expect(
      resolveIdentityProviderWizardClose({
        dirty: dirtyRef.current,
        persistResult,
        secretDirty: secretDirtyRef.current,
      }),
    ).toBe('close');
  });

  it('keeps the discard confirm when only a typed secret is dirty', async () => {
    const persistRef = {
      current: null as null | (() => Promise<'blocked' | 'clean' | 'conflict' | 'error' | 'saved'>),
    };
    const secretDirtyRef = { current: false };
    const dirtyRef = { current: false };

    render(
      <IdentityProviderWizardModalContent
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        dirtyRef={dirtyRef}
        persistRef={persistRef}
        provider={existingProvider}
        secretDirtyRef={secretDirtyRef}
        onChanged={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText(/identityProviders\.steps\.client/));
    });
    fireEvent.change(screen.getByLabelText('clientSecret'), { target: { value: 'typed-secret' } });
    expect(dirtyRef.current).toBe(true);
    expect(secretDirtyRef.current).toBe(true);

    let persistResult: 'blocked' | 'clean' | 'conflict' | 'error' | 'saved' = 'blocked';
    await act(async () => {
      persistResult = (await persistRef.current?.()) ?? 'blocked';
    });
    expect(persistResult).toBe('clean');
    expect(serviceMocks.update).not.toHaveBeenCalled();
    expect(
      resolveIdentityProviderWizardClose({
        dirty: dirtyRef.current,
        persistResult,
        secretDirty: secretDirtyRef.current,
      }),
    ).toBe('confirm');
  });

  it('stays open when close persist reports a conflict', async () => {
    serviceMocks.update.mockRejectedValueOnce({
      data: { errorData: { code: 'PLATFORM_REVISION_CONFLICT' } },
    } as never);
    const persistRef = {
      current: null as null | (() => Promise<'blocked' | 'clean' | 'conflict' | 'error' | 'saved'>),
    };

    render(
      <IdentityProviderWizardModalContent
        canCreate
        canPublish
        canTest
        canUpdate
        authMethod="better-auth"
        dirtyRef={{ current: false }}
        persistRef={persistRef}
        provider={existingProvider}
        onChanged={async () => {
          throw new Error('refresh failed');
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('displayName'), { target: { value: 'Conflicted' } });
    let persistResult: 'blocked' | 'clean' | 'conflict' | 'error' | 'saved' = 'blocked';
    await act(async () => {
      persistResult = (await persistRef.current?.()) ?? 'blocked';
    });
    expect(persistResult).toBe('conflict');
    expect(
      resolveIdentityProviderWizardClose({
        dirty: true,
        persistResult,
        secretDirty: false,
      }),
    ).toBe('stay');
  });
});
