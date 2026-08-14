import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderSettingsContext } from '../ModelList/ProviderSettingsContext';
import Checker from './Checker';

const mocks = vi.hoisted(() => ({
  aiProviderModelList: [] as { enabled: boolean; id: string; type: string }[],
  enabledAiModels: [] as { id: string; providerId: string; type: string }[],
  fetchPresetTaskResult: vi.fn(),
  list: vi.fn(),
  test: vi.fn(),
  updateAiProviderConfig: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_t, p) => String(p) }),
  cssVar: new Proxy({}, { get: (_t, p) => `var(--${String(p)})` }),
  cx: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@ant-design/icons', () => ({ CheckCircleFilled: () => <span>ok</span> }));
vi.mock('@lobehub/icons', () => ({ ModelIcon: () => <span>icon</span> }));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ extra, title }: { extra?: ReactNode; title?: ReactNode }) => (
    <div>
      <div data-testid="alert-title">{title}</div>
      {extra}
    </div>
  ),
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Highlighter: ({ children }: { children?: ReactNode }) => <pre>{children}</pre>,
  Icon: () => <span>spin</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Select: ({ value }: { value?: string }) => <div data-testid="check-model">{value}</div>,
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ allowed: true }) }));
vi.mock('@/hooks/useProviderName', () => ({ useProviderName: () => 'ChatGPT' }));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    admin: {
      aiProviders: { list: { query: mocks.list }, test: { mutate: mocks.test } },
    },
  },
}));

vi.mock('@/services/chat', () => ({
  chatService: { fetchPresetTaskResult: mocks.fetchPresetTaskResult },
}));

vi.mock('@/store/aiInfra', () => ({
  aiProviderSelectors: { isProviderConfigUpdating: () => () => false },
  useScopedAiInfraStore: (selector: (s: any) => unknown) =>
    selector({
      aiProviderModelList: mocks.aiProviderModelList,
      enabledAiModels: mocks.enabledAiModels,
      updateAiProviderConfig: mocks.updateAiProviderConfig,
    }),
}));

const noop = async () => {};

const renderChecker = (isAdmin: boolean, model = 'gpt-5.5') =>
  render(
    <ProviderSettingsContext value={isAdmin ? { hideFetchOnClient: true } : {}}>
      <Checker model={model} provider="chatgpt" onAfterCheck={noop} onBeforeCheck={noop} />
    </ProviderSettingsContext>,
  );

const clickCheck = () => fireEvent.click(screen.getByRole('button'));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.aiProviderModelList = [
    { enabled: false, id: 'gpt-5.5', type: 'chat' },
    { enabled: true, id: 'gpt-5.6-sol', type: 'chat' },
  ];
  mocks.enabledAiModels = [];
  mocks.list.mockResolvedValue({
    items: [{ id: 'platform-uuid', providerKey: 'chatgpt' }],
    nextCursor: null,
  });
});

describe('Checker — admin platform catalog', () => {
  it('sends the selected model to the platform probe', async () => {
    mocks.test.mockResolvedValue({ latencyMs: 12, status: 'success' });

    renderChecker(true);
    clickCheck();

    await waitFor(() =>
      expect(mocks.test).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'platform-uuid', model: 'gpt-5.5' }),
      ),
    );
  });

  it('shows the server reason instead of the generic empty-response guidance', async () => {
    mocks.test.mockResolvedValue({
      errorCategory: 'auth',
      latencyMs: 40,
      sanitizedMessage: 'Connection failed: authentication rejected',
      status: 'failure',
    });

    renderChecker(true);
    clickCheck();

    await waitFor(() =>
      expect(screen.getByTestId('alert-title').textContent).toBe(
        'Connection failed: authentication rejected',
      ),
    );
    expect(screen.getByTestId('alert-title').textContent).not.toContain('ConnectionCheckFailed');
  });

  it.each([
    ['check_model_not_configured', 'llm.checker.reason.checkModelNotConfigured'],
    ['Check model not configured', 'llm.checker.reason.checkModelNotConfigured'],
    ['check_model_not_enabled', 'llm.checker.reason.checkModelNotEnabled'],
    ['Check model not enabled.', 'llm.checker.reason.checkModelNotEnabled'],
  ])('maps the actionable refusal %s to dedicated copy', async (sanitizedMessage, key) => {
    mocks.test.mockResolvedValue({
      errorCategory: 'invalid_config',
      latencyMs: 0,
      sanitizedMessage,
      status: 'failure',
    });

    renderChecker(true);
    clickCheck();

    await waitFor(() => expect(screen.getByTestId('alert-title').textContent).toBe(key));
  });

  it('keeps the connectivity guidance for a genuine transport failure', async () => {
    mocks.test.mockRejectedValue(new Error('network down'));

    renderChecker(true);
    clickCheck();

    await waitFor(() =>
      expect(screen.getByTestId('alert-title').textContent).toBe(
        'modelRuntime:ConnectionCheckFailed',
      ),
    );
  });

  it('does not second-guess the persisted check model on the admin surface', () => {
    mocks.enabledAiModels = [{ id: 'gpt-5.6-sol', providerId: 'chatgpt', type: 'chat' }];

    renderChecker(true);

    expect(screen.getByTestId('check-model').textContent).toBe('gpt-5.5');
  });
});

describe('Checker — user surface model selection', () => {
  it('falls back to an enabled model when the card default is not served', () => {
    // chatgpt's card default is gpt-5.5; on a platform-managed provider only published models
    // pass the allowlist, and checking gpt-5.5 returned PLATFORM_AI_MODEL_NOT_PUBLISHED (→ 500).
    mocks.enabledAiModels = [{ id: 'gpt-5.6-sol', providerId: 'chatgpt', type: 'chat' }];

    renderChecker(false);

    expect(screen.getByTestId('check-model').textContent).toBe('gpt-5.6-sol');
  });

  it('keeps the card default when it is served', () => {
    mocks.enabledAiModels = [
      { id: 'gpt-5.5', providerId: 'chatgpt', type: 'chat' },
      { id: 'gpt-5.6-sol', providerId: 'chatgpt', type: 'chat' },
    ];

    renderChecker(false);

    expect(screen.getByTestId('check-model').textContent).toBe('gpt-5.5');
  });

  it('ignores enabled models that belong to another provider', () => {
    mocks.enabledAiModels = [{ id: 'claude-x', providerId: 'anthropic', type: 'chat' }];

    renderChecker(false);

    expect(screen.getByTestId('check-model').textContent).toBe('gpt-5.5');
  });

  it('checks the resolved model, not the card default', async () => {
    mocks.enabledAiModels = [{ id: 'gpt-5.6-sol', providerId: 'chatgpt', type: 'chat' }];
    mocks.fetchPresetTaskResult.mockResolvedValue(undefined);

    renderChecker(false);
    clickCheck();

    await waitFor(() =>
      expect(mocks.fetchPresetTaskResult).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ model: 'gpt-5.6-sol', provider: 'chatgpt' }),
        }),
      ),
    );
  });
});
