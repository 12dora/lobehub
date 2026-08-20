// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { SystemAgentItem, UserServiceModelConfigKey } from '@/types/user/settings';

import ModelAssignmentsFormView, {
  type ModelAssignmentsFormViewProps,
  type SystemAgentPolicyMetas,
} from './ModelAssignmentsFormView';

const { extendParamsMock } = vi.hoisted(() => ({
  extendParamsMock: vi.fn<() => string[] | undefined>(() => ['reasoningEffort']),
}));

vi.mock('@/store/aiInfra', () => ({
  aiModelSelectors: { modelExtendParams: () => () => extendParamsMock() },
  useScopedAiInfraStore: (selector: (state: unknown) => unknown) => selector({}),
}));

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

vi.mock('./EffortSelect', () => ({
  default: ({
    disabled,
    onChange,
    value,
  }: {
    disabled?: boolean;
    onChange?: (level: string | undefined, configKey: string) => void;
    value?: string;
  }) => (
    <>
      <button
        data-effort={value ?? ''}
        data-testid="effort-select"
        disabled={disabled}
        type="button"
        onClick={() => onChange?.('high', 'reasoningEffort')}
      />
      {/* The picker signals "unset" with undefined; the write site decides how to store it. */}
      <button
        data-testid="effort-clear"
        disabled={disabled}
        type="button"
        onClick={() => onChange?.(undefined, 'reasoningEffort')}
      />
    </>
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
  extra: Partial<ModelAssignmentsFormViewProps> = {},
) => {
  const onUpdateSystemAgent = extra.onUpdateSystemAgent ?? vi.fn();
  const onUpdateDefaultAgentEffort = extra.onUpdateDefaultAgentEffort;
  const props: ModelAssignmentsFormViewProps = {
    canManage: true,
    defaultAgent: { config: { model: 'default', provider: 'provider' } } as never,
    isInit: true,
    onUpdateDefaultAgent: vi.fn(),
    saveState: {
      lastSavedAt: null,
      retry: vi.fn(),
      save: async (operation: () => Promise<void> | void) => operation(),
      status: 'idle',
    } as never,
    systemAgentMetas,
    systemAgentSettings,
    ...extra,
    onUpdateDefaultAgentEffort,
    onUpdateSystemAgent,
  };
  render(<ModelAssignmentsFormView {...props} />);
  return { onUpdateDefaultAgentEffort, onUpdateSystemAgent };
};

describe('ModelAssignmentsFormView managed leaves', () => {
  beforeEach(() => {
    extendParamsMock.mockReturnValue(['reasoningEffort']);
  });

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

  it('writes the picked effort level through the same system-agent update', () => {
    const { onUpdateSystemAgent } = renderView({});

    const row = screen.getByTestId('form-item-systemAgent.historyCompress.title');
    fireEvent.click(within(row).getByTestId('effort-select'));

    expect(onUpdateSystemAgent).toHaveBeenCalledWith('historyCompress', {
      reasoningEffort: 'high',
    });
  });

  it('persists an explicit null when the effort picker is cleared to Default', () => {
    // The settings merge drops `undefined`, so only a null actually erases a saved level.
    const { onUpdateSystemAgent } = renderView({});

    const row = screen.getByTestId('form-item-systemAgent.historyCompress.title');
    fireEvent.click(within(row).getByTestId('effort-clear'));

    expect(onUpdateSystemAgent).toHaveBeenCalledWith('historyCompress', {
      reasoningEffort: null,
    });
  });

  it.each(['memoryAnalysisAgentConfig', 'topic'] as const)(
    'clears to null on the %s row too',
    (key) => {
      const { onUpdateSystemAgent } = renderView({});

      const row = screen.getByTestId(`form-item-systemAgent.${key}.title`);
      fireEvent.click(within(row).getByTestId('effort-clear'));

      expect(onUpdateSystemAgent).toHaveBeenCalledWith(key, { reasoningEffort: null });
    },
  );

  it('disables the effort picker alongside a locked model/provider cluster', () => {
    renderView({ agentMeta: { modelProvider: [meta({ locked: true }), meta()] } });

    const row = screen.getByTestId('form-item-systemAgent.agentMeta.title');
    expect(within(row).getByTestId('effort-select')).toBeDisabled();
  });

  it('offers no effort picker for the embedding memory row', () => {
    renderView({});

    const row = screen.getByTestId('form-item-systemAgent.userMemoryEmbedding.title');
    expect(within(row).queryByTestId('effort-select')).toBeNull();
  });

  it('renders the default-assistant effort picker only when the surface supplies a writer', () => {
    renderView({});
    expect(
      within(screen.getByTestId('form-item-defaultAgent.title')).queryByTestId('effort-select'),
    ).toBeNull();
  });

  it('writes default-assistant effort through the dedicated writer', () => {
    const onUpdateDefaultAgentEffort = vi.fn();
    renderView({}, { onUpdateDefaultAgentEffort });

    const row = screen.getByTestId('form-item-defaultAgent.title');
    fireEvent.click(within(row).getByTestId('effort-select'));

    expect(onUpdateDefaultAgentEffort).toHaveBeenCalledWith({
      configKey: 'reasoningEffort',
      level: 'high',
    });
  });

  it('forwards Default as an unset when the admin row is clearable', () => {
    const onUpdateDefaultAgentEffort = vi.fn();
    renderView({}, { defaultAgentEffortClearable: true, onUpdateDefaultAgentEffort });

    const row = screen.getByTestId('form-item-defaultAgent.title');
    fireEvent.click(within(row).getByTestId('effort-clear'));

    expect(onUpdateDefaultAgentEffort).toHaveBeenCalledWith({
      configKey: 'reasoningEffort',
      level: undefined,
    });
  });

  it('does not forward Default when the user chatConfig row is not clearable', () => {
    const onUpdateDefaultAgentEffort = vi.fn();
    renderView({}, { onUpdateDefaultAgentEffort });

    const row = screen.getByTestId('form-item-defaultAgent.title');
    fireEvent.click(within(row).getByTestId('effort-clear'));

    expect(onUpdateDefaultAgentEffort).not.toHaveBeenCalled();
  });

  it('locks only the active effort key, leaving model/provider and inactive keys editable', () => {
    const onUpdateDefaultAgentEffort = vi.fn();
    renderView(
      {},
      {
        defaultAgentEffortMetas: { reasoningEffort: meta({ locked: true }) },
        defaultAgentMetas: [meta(), meta()],
        onUpdateDefaultAgentEffort,
      },
    );

    const row = screen.getByTestId('form-item-defaultAgent.title');
    expect(screen.getByTestId('model-default')).not.toBeDisabled();
    expect(within(row).getByTestId('effort-select')).toBeDisabled();
    fireEvent.click(within(row).getByTestId('effort-select'));
    expect(onUpdateDefaultAgentEffort).not.toHaveBeenCalled();
  });

  it('ignores a locked or hidden inactive effort family', () => {
    renderView(
      {},
      {
        defaultAgentEffortMetas: {
          gpt5_6ReasoningEffort: meta({ hidden: true, locked: true }),
        },
        defaultAgentMetas: [meta(), meta()],
        onUpdateDefaultAgentEffort: vi.fn(),
      },
    );

    const row = screen.getByTestId('form-item-defaultAgent.title');
    expect(screen.getByTestId('model-default')).not.toBeDisabled();
    expect(within(row).getByTestId('effort-select')).not.toBeDisabled();
  });

  it('hides only the effort picker when the active effort leaf is hidden', () => {
    renderView(
      {},
      {
        defaultAgentEffortMetas: { reasoningEffort: meta({ hidden: true }) },
        defaultAgentMetas: [meta(), meta()],
        onUpdateDefaultAgentEffort: vi.fn(),
      },
    );

    expect(screen.getByTestId('model-default')).toBeTruthy();
    const row = screen.getByTestId('form-item-defaultAgent.title');
    expect(within(row).queryByTestId('effort-select')).toBeNull();
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
