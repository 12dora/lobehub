import { act, fireEvent, render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mapFeatureFlagsEnvToState } from '@/config/featureFlags';
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
  Icon: () => null,
  ShikiLobeTheme: {},
}));

vi.mock('@lobehub/ui/base-ui', () => ({
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

    // Even with telemetry:true in the store, the anonymous-usage switch renders OFF because the
    // telemetry selector is hard-forced to false (built-in telemetry removed).
    expect(screen.getByRole('switch')).not.toBeChecked();
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
