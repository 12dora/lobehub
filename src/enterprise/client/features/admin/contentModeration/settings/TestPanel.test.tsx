// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import type { ModerationSettingsDraft } from './draft';
import TestPanel from './TestPanel';

const mocks = vi.hoisted(() => ({ test: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('@lobehub/ui', () => ({
  Alert: ({ message, ...rest }: { message?: ReactNode }) => <div {...rest}>{message}</div>,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children, ...rest }: { children?: ReactNode }) => <span {...rest}>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  TextArea: ({
    onChange,
    value,
  }: {
    onChange?: (event: { target: { value: string } }) => void;
    value?: string;
  }) => (
    <textarea
      aria-label="test-text"
      value={value ?? ''}
      onChange={(event) => onChange?.({ target: { value: event.target.value } })}
    />
  ),
  Tooltip: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../records/CategoryScoreBars', () => ({ default: () => <div data-testid="bars" /> }));
vi.mock('../service', () => ({
  adminContentModerationService: { testClassifier: (...args: unknown[]) => mocks.test(...args) },
}));
vi.mock('../../primitives/runAdminMutation', () => ({
  runAdminMutation: async ({
    onError,
    run,
  }: {
    onError?: (error: unknown) => void;
    run: () => Promise<void>;
  }) => {
    try {
      await run();
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    }
  },
}));
vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'better-auth', permissions: [], status: 'allowed' }),
}));

const draft = (): ModerationSettingsDraft =>
  ({
    addedApiKeys: [],
    config: createDefaultContentModerationConfig(),
  }) as unknown as ModerationSettingsDraft;

const output = {
  latencyMs: 120,
  policyAction: 'block' as const,
  scores: { sexual: 0.9 },
  source: 'keyword' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.test.mockResolvedValue(output);
});

const runTest = async (text = 'sample') => {
  fireEvent.change(screen.getByLabelText('test-text'), { target: { value: text } });
  fireEvent.click(screen.getByText('contentModeration.settings.classifier.test'));
  await waitFor(() => expect(screen.getByTestId('moderation-test-result')).toBeTruthy());
};

describe('TestPanel', () => {
  it('runs against the current form and shows a fresh result', async () => {
    render(<TestPanel canManage draft={draft()} />);
    await runTest();
    expect(mocks.test).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('moderation-test-result').dataset.stale).toBe('false');
    expect(screen.queryByTestId('test-result-stale')).toBeNull();
  });

  it('marks the result stale once the sample text changes', async () => {
    render(<TestPanel canManage draft={draft()} />);
    await runTest();
    fireEvent.change(screen.getByLabelText('test-text'), { target: { value: 'different' } });
    expect(screen.getByTestId('moderation-test-result').dataset.stale).toBe('true');
    expect(screen.getByTestId('test-result-stale')).toBeTruthy();
  });

  it('marks the result stale once the settings change under it', async () => {
    const { rerender } = render(<TestPanel canManage draft={draft()} />);
    await runTest();
    expect(screen.getByTestId('moderation-test-result').dataset.stale).toBe('false');

    const edited = draft();
    edited.config.categories.sexual = { action: 'block', threshold: 0.1 };
    rerender(<TestPanel canManage draft={edited} />);
    expect(screen.getByTestId('moderation-test-result').dataset.stale).toBe('true');
  });

  it('names the rejected field instead of a generic failure', async () => {
    mocks.test.mockRejectedValue({
      data: {
        errorData: {
          code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
          details: {
            field: 'classifier.moderationsApi.baseUrl',
            reason: 'endpoint_changed_reenter_keys',
          },
        },
      },
      message: 'PLATFORM_CONFIG_VALIDATION_FAILED',
    });
    render(<TestPanel canManage draft={draft()} />);
    fireEvent.change(screen.getByLabelText('test-text'), { target: { value: 'sample' } });
    fireEvent.click(screen.getByText('contentModeration.settings.classifier.test'));
    await waitFor(() =>
      expect(screen.getByTestId('test-error').textContent).toBe(
        'contentModeration.errors.reason.endpointChanged',
      ),
    );
  });

  it('disables the run button for a read-only admin', () => {
    render(<TestPanel canManage={false} draft={draft()} />);
    expect(
      (screen.getByText('contentModeration.settings.classifier.test') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe('TestPanel — unusable classifier', () => {
  const moderationsDraft = (baseUrl: string, added: string[] = []) =>
    ({
      addedApiKeys: added,
      config: {
        ...createDefaultContentModerationConfig(),
        classifier: {
          kind: 'moderations_api',
          moderationsApi: {
            apiKeys: [{ fingerprint: 'fp-1', masked: 'sk-…ab12' }],
            baseUrl,
            model: 'omni-moderation-latest',
          },
          onError: 'allow',
          retryCount: 1,
          timeoutMs: 3000,
        },
      },
    }) as unknown as ModerationSettingsDraft;

  it('runs while the stored key still applies to the endpoint', async () => {
    render(
      <TestPanel
        canManage
        draft={moderationsDraft('https://api.example.com')}
        persistedBaseUrl="https://api.example.com"
      />,
    );
    expect(screen.queryByTestId('test-blocked')).toBeNull();
    await runTest();
    expect(mocks.test).toHaveBeenCalledTimes(1);
  });

  it('blocks the dry run when the endpoint change leaves no key behind', () => {
    render(
      <TestPanel
        canManage
        draft={moderationsDraft('https://moved.example.com')}
        persistedBaseUrl="https://api.example.com"
      />,
    );
    expect(screen.getByTestId('test-blocked').textContent).toBe(
      'contentModeration.errors.moderationsApiKeyRequired',
    );
    fireEvent.change(screen.getByLabelText('test-text'), { target: { value: 'sample' } });
    const button = screen.getByText(
      'contentModeration.settings.classifier.test',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.test).not.toHaveBeenCalled();
  });

  it('unblocks once a replacement key is typed', () => {
    render(
      <TestPanel
        canManage
        draft={moderationsDraft('https://moved.example.com', ['sk-new'])}
        persistedBaseUrl="https://api.example.com"
      />,
    );
    expect(screen.queryByTestId('test-blocked')).toBeNull();
  });
});
