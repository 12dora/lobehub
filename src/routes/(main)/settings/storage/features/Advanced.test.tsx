import { act, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mapFeatureFlagsEnvToState } from '@/config/featureFlags';
import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { initServerConfigStore, Provider } from '@/store/serverConfig/store';
import { useUserStore } from '@/store/user';

import AdvancedActions from './Advanced';

const mocks = vi.hoisted(() => ({
  confirmModal: vi.fn(),
  messageError: vi.fn(),
  messageSuccess: vi.fn(),
}));

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    },
  });
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@lobehub/ui', () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  Form: ({
    items,
  }: {
    items: {
      children: { children?: ReactNode; desc?: string; label: string }[];
      title: string;
    }[];
  }) => (
    <div>
      {items.map((group) => (
        <section key={group.title}>
          <h2>{group.title}</h2>
          {group.children.map((item) => (
            <div key={item.label}>
              <span>{item.label}</span>
              {item.desc && <span>{item.desc}</span>}
              {item.children}
            </div>
          ))}
        </section>
      ))}
    </div>
  ),
  Flexbox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  ShikiLobeTheme: {},
  Skeleton: { Button: () => null },
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  confirmModal: mocks.confirmModal,
  Switch: ({
    checked,
    disabled,
    onChange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onChange?: (checked: boolean) => void;
  }) => (
    <button
      aria-checked={checked}
      disabled={disabled}
      role="switch"
      onClick={() => {
        onChange?.(!checked);
      }}
    />
  ),
}));

vi.mock('antd', () => ({
  App: {
    useApp: () => ({
      message: { error: mocks.messageError, success: mocks.messageSuccess },
      modal: { confirm: vi.fn() },
    }),
  },
}));

vi.mock('@/business/client/features/AccountDeletion', () => ({
  default: () => <div />,
}));

vi.mock('@/features/DataImporter', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/services/config', () => ({
  configService: {
    exportAll: vi.fn(),
  },
}));

vi.mock('@/features/PlatformSettingSourceBadge/usePlatformSettingMeta', () => ({
  usePlatformSettingMeta: vi.fn(),
}));

const lockedMeta = (overrides: Partial<PlatformSettingMetaState> = {}): PlatformSettingMetaState =>
  ({
    canReset: false,
    enabled: false,
    error: undefined,
    hidden: false,
    isLoading: false,
    locked: false,
    meta: undefined,
    mode: undefined,
    reset: vi.fn(),
    resetError: null,
    resetting: false,
    retry: vi.fn(),
    source: undefined,
    status: 'disabled',
    ...overrides,
  }) as PlatformSettingMetaState;

const createWrapper = (hideDocs: boolean) => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <Provider
      createStore={() =>
        initServerConfigStore({
          featureFlags: {
            ...mapFeatureFlagsEnvToState({
              commercial_hide_docs: false,
            }),
            hideDocs,
          },
        })
      }
    >
      {children}
    </Provider>
  );

  return Wrapper;
};

const initialUserStoreState = useUserStore.getState();

beforeEach(() => {
  vi.mocked(usePlatformSettingMeta).mockReturnValue(lockedMeta());
});

afterEach(() => {
  vi.clearAllMocks();
  useUserStore.setState(initialUserStoreState, true);
});

describe('AdvancedActions', () => {
  it('does not duplicate analytics when About settings are visible', () => {
    render(<AdvancedActions />, { wrapper: createWrapper(false) });

    expect(screen.queryByText('analytics.title')).toBeNull();
    expect(screen.getByText('storage.actions.title')).toBeDefined();
  });

  it('shows telemetry as a fallback when About settings are hidden', () => {
    const updateGeneralConfig = vi.fn();

    useUserStore.setState({
      settings: { general: { telemetry: true } },
      updateGeneralConfig,
    });

    render(<AdvancedActions />, { wrapper: createWrapper(true) });

    expect(screen.getByText('analytics.title')).toBeDefined();
    expect(screen.getByText('analytics.telemetry.title')).toBeDefined();
    expect(screen.getByRole('switch')).toBeChecked();

    fireEvent.click(screen.getByRole('switch'));
    expect(updateGeneralConfig).toHaveBeenCalledWith({ telemetry: false });
  });

  it('keeps a locked-off telemetry setting visible but greyed out', () => {
    const updateGeneralConfig = vi.fn();
    vi.mocked(usePlatformSettingMeta).mockReturnValue(
      lockedMeta({
        effectiveValue: false,
        enabled: true,
        locked: true,
        mode: 'locked',
        status: 'ready',
      }),
    );
    useUserStore.setState({ settings: { general: { telemetry: false } }, updateGeneralConfig });

    render(<AdvancedActions />, { wrapper: createWrapper(true) });

    expect(screen.getByText('analytics.telemetry.title')).toBeDefined();
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByRole('switch')).toBeDisabled();

    fireEvent.click(screen.getByRole('switch'));
    expect(updateGeneralConfig).not.toHaveBeenCalled();
  });

  it('shows the enforced value, not the stale stored opt-in, on a locked path', () => {
    // The store still carries the pre-policy `true` until the next user-state refresh, so a
    // store-driven switch would render disabled-but-ON against a policy that enforces OFF.
    vi.mocked(usePlatformSettingMeta).mockReturnValue(
      lockedMeta({
        effectiveValue: false,
        enabled: true,
        locked: true,
        mode: 'locked',
        status: 'ready',
      }),
    );
    useUserStore.setState({ settings: { general: { telemetry: true } } });

    render(<AdvancedActions />, { wrapper: createWrapper(true) });

    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('awaits reset completion before showing success feedback', async () => {
    let resolveReset!: () => void;
    const resetSettings = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReset = resolve;
        }),
    );
    useUserStore.setState({ resetSettings });
    render(<AdvancedActions />, { wrapper: createWrapper(false) });

    fireEvent.click(screen.getByText('danger.reset.action'));
    const onOk = mocks.confirmModal.mock.calls[0][0].onOk as () => Promise<void>;
    let confirmation: Promise<void> = Promise.resolve();
    act(() => {
      confirmation = onOk();
    });

    expect(resetSettings).toHaveBeenCalledTimes(1);
    expect(mocks.messageSuccess).not.toHaveBeenCalled();

    await act(async () => {
      resolveReset();
      await confirmation;
    });
    expect(mocks.messageSuccess).toHaveBeenCalledWith('danger.reset.success');
    expect(mocks.messageError).not.toHaveBeenCalled();
  });

  it('surfaces reset failure without reporting success or rejecting the confirmation', async () => {
    const resetFailure = new Error('Reset failed');
    const resetSettings = vi.fn().mockRejectedValue(resetFailure);
    useUserStore.setState({ resetSettings });
    render(<AdvancedActions />, { wrapper: createWrapper(false) });

    fireEvent.click(screen.getByText('danger.reset.action'));
    const onOk = mocks.confirmModal.mock.calls[0][0].onOk as () => Promise<void>;
    await expect(onOk()).resolves.toBeUndefined();

    expect(resetSettings).toHaveBeenCalledTimes(1);
    expect(mocks.messageError).toHaveBeenCalledWith('danger.reset.error');
    expect(mocks.messageSuccess).not.toHaveBeenCalled();
  });
});
