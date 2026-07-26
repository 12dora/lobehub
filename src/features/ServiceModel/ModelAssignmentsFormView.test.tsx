// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { SystemAgentItem, UserServiceModelConfigKey } from '@/types/user/settings';

import ModelAssignmentsFormView, {
  type ModelAssignmentsFormViewProps,
  type SystemAgentPolicyMetas,
} from './ModelAssignmentsFormView';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd', () => ({
  ConfigProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Form: ({
    items,
  }: {
    items: Array<{ children: Array<{ children: ReactNode; label: ReactNode }> }>;
  }) => (
    <div>
      {items.flatMap((group) =>
        group.children.map((item, index) => (
          <section
            data-testid={`form-item-${typeof item.label === 'string' ? item.label : index}`}
            key={`${String(item.label)}-${index}`}
          >
            {item.label}
            {item.children}
          </section>
        )),
      )}
    </div>
  ),
  InputNumber: ({
    disabled,
    onChange,
    value,
  }: {
    disabled?: boolean;
    onChange?: (value: number) => void;
    value?: number;
  }) => (
    <input
      disabled={disabled}
      role="spinbutton"
      value={value ?? ''}
      onChange={(event) => onChange?.(Number(event.target.value))}
    />
  ),
  Skeleton: () => <div>loading</div>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Switch: ({
    'aria-label': ariaLabel,
    disabled,
    onChange,
  }: {
    'aria-label': string;
    'disabled'?: boolean;
    'onChange'?: (value: boolean) => void;
  }) => (
    <button
      aria-label={ariaLabel}
      disabled={disabled}
      type="button"
      onClick={() => onChange?.(true)}
    />
  ),
}));

vi.mock('@/features/ModelSelect', () => ({
  default: ({
    disabled,
    onChange,
    value,
  }: {
    disabled?: boolean;
    onChange?: (value: { model: string; provider: string }) => void;
    value: SystemAgentItem;
  }) => (
    <button
      data-testid={`model-${value.model}`}
      disabled={disabled}
      type="button"
      onClick={() => onChange?.({ model: `${value.model}-next`, provider: value.provider })}
    >
      {value.model}
    </button>
  ),
}));

vi.mock('@/features/PlatformSettingSourceBadge/ManagedSettingField', () => ({
  ManagedCompositeSettingFieldContent: ({
    children,
    metas,
  }: {
    children: (state: { disabled: boolean }) => ReactNode;
    metas: PlatformSettingMetaState[];
  }) => {
    if (metas.some((meta) => meta.hidden)) return null;
    return children({
      disabled: metas.some(
        (meta) =>
          meta.locked || meta.resetting || meta.status === 'loading' || meta.status === 'error',
      ),
    });
  },
}));

vi.mock('@/components/AsyncError', () => ({
  default: () => <div>error</div>,
}));

vi.mock('@/components/Editor/AutoSaveHint', () => ({
  default: () => null,
}));

const meta = (overrides: Partial<PlatformSettingMetaState> = {}): PlatformSettingMetaState => ({
  canReset: false,
  enabled: true,
  error: undefined,
  hidden: false,
  isLoading: false,
  locked: false,
  meta: undefined,
  mode: 'default',
  reset: async () => false,
  resetError: null,
  resetting: false,
  retry: async () => undefined,
  source: 'platform',
  status: 'ready',
  ...overrides,
});

const keys: UserServiceModelConfigKey[] = [
  'agentMeta',
  'followUpAction',
  'generationTopic',
  'historyCompress',
  'inputCompletion',
  'memoryAnalysisAgentConfig',
  'promptRewrite',
  'thread',
  'topic',
  'translation',
  'userMemoryEmbedding',
  'userMemoryPersonaWriter',
];

const systemAgentSettings = Object.fromEntries(
  keys.map((key) => [
    key,
    {
      contextLimit: 4096,
      enabled: true,
      model: key,
      provider: 'provider',
    },
  ]),
) as Record<UserServiceModelConfigKey, SystemAgentItem>;

const renderView = (
  systemAgentMetas: Partial<Record<UserServiceModelConfigKey, SystemAgentPolicyMetas>>,
) => {
  const onUpdateSystemAgent = vi.fn();
  const props: ModelAssignmentsFormViewProps = {
    canManage: true,
    defaultAgent: { config: { model: 'default', provider: 'provider' } } as never,
    isInit: true,
    onUpdateDefaultAgent: vi.fn(),
    onUpdateSystemAgent,
    saveState: {
      lastSavedAt: null,
      retry: vi.fn(),
      save: async (operation: () => Promise<void> | void) => operation(),
      status: 'idle',
    } as never,
    systemAgentMetas,
    systemAgentSettings,
  };
  render(<ModelAssignmentsFormView {...props} />);
  return { onUpdateSystemAgent };
};

describe('ModelAssignmentsFormView managed leaves', () => {
  it('disables a locked model/provider pair and never invokes its update', () => {
    const { onUpdateSystemAgent } = renderView({
      agentMeta: { modelProvider: [meta({ locked: true }), meta()] },
    });

    const control = screen.getByTestId('model-agentMeta');
    expect(control).toBeDisabled();
    fireEvent.click(control);
    expect(onUpdateSystemAgent).not.toHaveBeenCalledWith('agentMeta', expect.anything());
  });

  it('hides the complete row when any governing leaf is hidden', () => {
    renderView({
      followUpAction: {
        enabled: meta({ hidden: true }),
        modelProvider: [meta(), meta()],
      },
    });

    expect(screen.queryByTestId('model-followUpAction')).toBeNull();
  });

  it('locks only contextLimit while leaving the memory model/provider selector editable', () => {
    renderView({
      userMemoryEmbedding: {
        contextLimit: meta({ locked: true }),
        modelProvider: [meta(), meta()],
      },
    });

    expect(screen.getByTestId('model-userMemoryEmbedding')).not.toBeDisabled();
    const row = screen.getByTestId('form-item-systemAgent.userMemoryEmbedding.title');
    expect(within(row).getByRole('spinbutton')).toBeDisabled();
  });
});
