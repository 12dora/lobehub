// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import type { ModerationSettingsBundle } from '../types';
import SettingsTab from './SettingsTab';

const bundle = (revision = 4): ModerationSettingsBundle => ({
  catalog: [{ label: 'GPT-4o', model: 'gpt-4o', provider: 'openai', providerLabel: 'OpenAI' }],
  roles: ['super_admin'],
  settings: {
    ...createDefaultContentModerationConfig(),
    revision,
    updatedAt: new Date('2026-08-17T00:00:00.000Z'),
    updatedBy: 'admin-1',
  } as ModerationSettingsBundle['settings'],
});

const mocks = vi.hoisted(() => ({
  fetch: {
    data: undefined as unknown,
    error: undefined as Error | undefined,
    isLoading: false,
    mutate: vi.fn(async (): Promise<ModerationSettingsBundle | undefined> => undefined),
  },
  toastError: vi.fn(),
  guardEnabled: false,
  toastSuccess: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ action, message }: { action?: ReactNode; message?: ReactNode }) => (
    <div data-testid="alert">
      <span>{message}</span>
      {action}
    </div>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Skeleton: { Block: () => <div data-testid="skeleton" /> },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
  Tooltip: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'better-auth', permissions: [], status: 'allowed' }),
}));

vi.mock('../hooks', () => ({
  invalidateModerationOverview: vi.fn(async () => undefined),
  useModerationSettings: () => mocks.fetch,
}));

vi.mock('../service', () => ({
  adminContentModerationService: {
    clearDecisionCache: vi.fn(),
    updateSettings: (...args: unknown[]) => mocks.updateSettings(...args),
  },
}));

vi.mock('../../primitives/runAdminMutation', () => ({
  runAdminMutation: async ({
    onError,
    run,
  }: {
    onError?: (error: unknown) => Promise<void> | void;
    run: () => Promise<void>;
  }) => {
    try {
      await run();
      return true;
    } catch (error) {
      await onError?.(error);
      return false;
    }
  },
}));

vi.mock('../../primitives/DangerConfirm', () => ({ openDangerConfirm: vi.fn() }));
vi.mock('../../primitives/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: (options: { enabled: boolean }) => {
    mocks.guardEnabled = options.enabled;
  },
}));

// Sections are exercised by their own tests; here only the save/CAS shell matters.
// `vi.mock` factories are hoisted, so the stub helper must be hoisted with them.
const { stubSection } = vi.hoisted(() => ({
  stubSection: (testid: string) => ({
    default: (props: { onPatch: (patch: Record<string, unknown>) => void }) => (
      <div data-testid={testid}>
        <button type="button" onClick={() => props.onPatch({ mode: 'observe' })}>
          {`edit-${testid}`}
        </button>
      </div>
    ),
  }),
}));
vi.mock('./sections/BasicSection', () => ({
  default: (props: {
    config: { messages: Record<string, unknown> };
    onPatch: (patch: Record<string, unknown>) => void;
  }) => (
    <div data-testid="section-basic">
      <button type="button" onClick={() => props.onPatch({ mode: 'observe' })}>
        edit-section-basic
      </button>
      <button
        type="button"
        onClick={() =>
          props.onPatch({
            messages: { ...props.config.messages, downgradeMessage: 'x'.repeat(400) },
          })
        }
      >
        overlong-downgrade-message
      </button>
    </div>
  ),
}));
vi.mock('./sections/ScopeSection', () => stubSection('section-scope'));
vi.mock('./sections/ClassifierSection', () => ({
  default: (props: {
    draft: {
      addedApiKeys: string[];
      config: {
        classifier: {
          moderationsApi?: { apiKeys: { masked: string }[]; baseUrl: string; model: string };
        };
      };
    };
    fieldError?: { message: string } | null;
    onAddedKeysChange: (keys: string[]) => void;
    onPatch: (patch: Record<string, unknown>) => void;
    persistedBaseUrl?: string;
  }) => (
    <div data-testid="section-classifier">
      <span data-testid="persisted-base-url">{props.persistedBaseUrl ?? ''}</span>
      <span data-testid="classifier-field-error">{props.fieldError?.message ?? ''}</span>
      <span data-testid="masked-keys">
        {(props.draft.config.classifier.moderationsApi?.apiKeys ?? [])
          .map((key) => key.masked)
          .join(',')}
      </span>
      <span data-testid="added-keys">{props.draft.addedApiKeys.join(',')}</span>
      <button type="button" onClick={() => props.onAddedKeysChange(['sk-plaintext'])}>
        add-key
      </button>
      <button
        type="button"
        onClick={() =>
          props.onPatch({
            classifier: {
              ...props.draft.config.classifier,
              moderationsApi: {
                ...props.draft.config.classifier.moderationsApi!,
                baseUrl: 'https://moved.example.com',
              },
            },
          })
        }
      >
        move-endpoint
      </button>
    </div>
  ),
}));
vi.mock('./sections/CategoriesSection', () => stubSection('section-categories'));
vi.mock('./sections/KeywordsSection', () => ({
  default: (props: {
    fieldError?: { message: string; ruleIndex?: number } | null;
    importText: string;
    onImportTextChange: (text: string) => void;
    onPatch: (patch: Record<string, unknown>) => void;
  }) => (
    <div data-testid="section-keywords">
      <span data-testid="keywords-field-error">{props.fieldError?.message ?? ''}</span>
      <span data-testid="keywords-field-error-index">{props.fieldError?.ruleIndex ?? ''}</span>
      <button type="button" onClick={() => props.onImportTextChange('pasted\nrules')}>
        paste-import
      </button>
      <span data-testid="import-text">{props.importText}</span>
      <button
        type="button"
        onClick={() =>
          props.onPatch({
            keywords: [
              {
                action: 'block',
                category: 'illicit',
                enabled: true,
                id: '00000000-0000-4000-8000-000000000000',
                isRegex: true,
                pattern: '([a-z',
              },
            ],
          })
        }
      >
        break-regex
      </button>
    </div>
  ),
}));
vi.mock('./sections/CacheSection', () => stubSection('section-cache'));
vi.mock('./sections/AutoBanSection', () => stubSection('section-autoban'));
vi.mock('./sections/RecordsSection', () => ({
  default: (props: { onPatch: (patch: Record<string, unknown>) => void }) => (
    <div data-testid="section-records">
      <button
        type="button"
        onClick={() =>
          props.onPatch({
            records: {
              hitRetentionDays: 180,
              nonHitRetentionDays: 30,
              recordNonHits: true,
              storeFullPrompt: false,
            },
          })
        }
      >
        break-retention
      </button>
    </div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.data = bundle();
  mocks.fetch.error = undefined;
  mocks.fetch.isLoading = false;
});

describe('SettingsTab', () => {
  it('keeps 保存 disabled until something actually changed', () => {
    render(<SettingsTab canManage enabled />);
    const save = screen.getByText('contentModeration.settings.save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.click(screen.getByText('edit-section-basic'));
    expect(
      (screen.getByText('contentModeration.settings.save') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('saves with the loaded revision as the CAS expectation', async () => {
    mocks.updateSettings.mockResolvedValue(bundle(5));
    render(<SettingsTab canManage enabled />);
    fireEvent.click(screen.getByText('edit-section-basic'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));

    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(1));
    expect(mocks.updateSettings.mock.calls[0][0]).toMatchObject({ expectedRevision: 4 });
    expect(mocks.updateSettings.mock.calls[0][0].config.mode).toBe('observe');
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('contentModeration.toast.saveSuccess'),
    );
  });

  it('surfaces a revision conflict with a reload affordance instead of overwriting', async () => {
    mocks.updateSettings.mockRejectedValue({
      data: { code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT },
      message: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
    });
    render(<SettingsTab canManage enabled />);
    fireEvent.click(screen.getByText('edit-section-basic'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('contentModeration.toast.conflict'),
    );
    expect(screen.getByText('contentModeration.settings.conflictTitle')).toBeTruthy();
    expect(screen.getByText('contentModeration.settings.reload')).toBeTruthy();
  });

  it('blocks the save on an uncompilable regex rule and names the row', async () => {
    render(<SettingsTab canManage enabled />);
    fireEvent.click(screen.getByText('break-regex'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('contentModeration.errors.keywordRegex'),
    );
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('blocks the save when the allowed-record retention exceeds the hard cap', async () => {
    render(<SettingsTab canManage enabled />);
    fireEvent.click(screen.getByText('break-retention'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('contentModeration.errors.nonHitRetention'),
    );
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('tells a read-only admin why nothing can be saved', () => {
    render(<SettingsTab enabled canManage={false} />);
    expect(screen.getByText('contentModeration.settings.readOnly')).toBeTruthy();
    expect(
      (screen.getByText('contentModeration.settings.save') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('offers a retry when the settings could not be loaded', () => {
    mocks.fetch.data = undefined;
    mocks.fetch.error = new Error('boom');
    render(<SettingsTab canManage enabled />);
    expect(screen.getByText('contentModeration.settings.loadFailed')).toBeTruthy();
  });
});

describe('SettingsTab — fix round 1', () => {
  it('treats an unapplied batch-import paste as unsaved work without enabling 保存', () => {
    render(<SettingsTab canManage enabled />);
    expect(mocks.guardEnabled).toBe(false);
    fireEvent.click(screen.getByText('paste-import'));
    expect(mocks.guardEnabled).toBe(true);
    expect(screen.getByTestId('import-text').textContent).toBe('pasted\nrules');
    // Pending import text is not a config change — saving it would bump the revision for nothing.
    expect(
      (screen.getByText('contentModeration.settings.save') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('hands the classifier the persisted endpoint, not the edited draft value', () => {
    mocks.fetch.data = {
      ...bundle(),
      settings: {
        ...bundle().settings,
        classifier: {
          kind: 'moderations_api',
          moderationsApi: {
            apiKeys: [{ fingerprint: 'fp-1', masked: 'sk-…ab12' }],
            baseUrl: 'https://api.example.com',
            model: 'omni-moderation-latest',
          },
          onError: 'allow',
          retryCount: 1,
          timeoutMs: 3000,
        },
      },
    } as unknown as ModerationSettingsBundle;
    render(<SettingsTab canManage enabled />);
    expect(screen.getByTestId('persisted-base-url').textContent).toBe('https://api.example.com');
    // Stored keys only ever reach the form masked.
    expect(screen.getByTestId('masked-keys').textContent).toBe('sk-…ab12');
  });

  it('transmits a typed key exactly once and clears it from the form afterwards', async () => {
    const moderationsBundle = (revision: number) =>
      ({
        ...bundle(revision),
        settings: {
          ...bundle(revision).settings,
          classifier: {
            kind: 'moderations_api',
            moderationsApi: {
              apiKeys: [{ fingerprint: 'fp-1', masked: 'sk-…ab12' }],
              baseUrl: 'https://api.example.com',
              model: 'omni-moderation-latest',
            },
            onError: 'allow',
            retryCount: 1,
            timeoutMs: 3000,
          },
        },
      }) as unknown as ModerationSettingsBundle;

    mocks.fetch.data = moderationsBundle(4);
    mocks.updateSettings.mockResolvedValue(moderationsBundle(5));
    render(<SettingsTab canManage enabled />);

    fireEvent.click(screen.getByText('add-key'));
    expect(screen.getByTestId('added-keys').textContent).toBe('sk-plaintext');
    fireEvent.click(screen.getByText('contentModeration.settings.save'));

    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(1));
    // The plaintext key must actually be on the wire, alongside the retained fingerprint.
    expect(mocks.updateSettings.mock.calls[0][0].config.classifier.moderationsApi.apiKeys).toEqual({
      add: ['sk-plaintext'],
      keep: ['fp-1'],
    });

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('contentModeration.toast.saveSuccess'),
    );
    // The reloaded snapshot replaces the draft: the plaintext input is empty again…
    expect(screen.getByTestId('added-keys').textContent).toBe('');
    expect(
      (screen.getByText('contentModeration.settings.save') as HTMLButtonElement).disabled,
    ).toBe(true);

    // …and a second save never re-sends it.
    mocks.updateSettings.mockResolvedValue(moderationsBundle(6));
    fireEvent.click(screen.getByText('edit-section-basic'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(2));
    expect(mocks.updateSettings.mock.calls[1][0].config.classifier.moderationsApi.apiKeys).toEqual({
      add: [],
      keep: ['fp-1'],
    });
  });

  it('blocks 保存 when the endpoint change would leave the classifier with no key', async () => {
    mocks.fetch.data = {
      ...bundle(),
      settings: {
        ...bundle().settings,
        classifier: {
          kind: 'moderations_api',
          moderationsApi: {
            apiKeys: [{ fingerprint: 'fp-1', masked: 'sk-…ab12' }],
            baseUrl: 'https://api.example.com',
            model: 'omni-moderation-latest',
          },
          onError: 'allow',
          retryCount: 1,
          timeoutMs: 3000,
        },
      },
    } as unknown as ModerationSettingsBundle;
    render(<SettingsTab canManage enabled />);

    // No local edit yet — the retained key still counts, so nothing is flagged.
    expect(screen.getByTestId('classifier-field-error').textContent).toBe('');

    fireEvent.click(screen.getByText('move-endpoint'));
    expect(screen.getByTestId('classifier-field-error').textContent).toBe(
      'contentModeration.errors.moderationsApiKeyRequired',
    );

    fireEvent.click(screen.getByText('contentModeration.settings.save'));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'contentModeration.errors.moderationsApiKeyRequired',
      ),
    );
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('lets the save through again once a replacement key is entered', async () => {
    mocks.fetch.data = {
      ...bundle(),
      settings: {
        ...bundle().settings,
        classifier: {
          kind: 'moderations_api',
          moderationsApi: {
            apiKeys: [{ fingerprint: 'fp-1', masked: 'sk-…ab12' }],
            baseUrl: 'https://api.example.com',
            model: 'omni-moderation-latest',
          },
          onError: 'allow',
          retryCount: 1,
          timeoutMs: 3000,
        },
      },
    } as unknown as ModerationSettingsBundle;
    mocks.updateSettings.mockResolvedValue(bundle(5));
    render(<SettingsTab canManage enabled />);

    fireEvent.click(screen.getByText('move-endpoint'));
    fireEvent.click(screen.getByText('add-key'));
    expect(screen.getByTestId('classifier-field-error').textContent).toBe('');

    fireEvent.click(screen.getByText('contentModeration.settings.save'));
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(1));
    // The endpoint moved, so the old fingerprint is dropped and only the new key is sent.
    expect(mocks.updateSettings.mock.calls[0][0].config.classifier.moderationsApi.apiKeys).toEqual({
      add: ['sk-plaintext'],
      keep: [],
    });
  });

  it('rejects an over-long downgrade notice before it reaches the server', async () => {
    render(<SettingsTab canManage enabled />);
    fireEvent.click(screen.getByText('overlong-downgrade-message'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'contentModeration.errors.downgradeMessageTooLong',
      ),
    );
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('replaces the draft and adopts the new revision when the conflict banner is reloaded', async () => {
    mocks.updateSettings.mockRejectedValue({
      data: { code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT },
      message: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT,
    });
    mocks.fetch.mutate.mockResolvedValue(bundle(9));
    render(<SettingsTab canManage enabled />);
    fireEvent.click(screen.getByText('edit-section-basic'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));
    await waitFor(() => expect(screen.getByText('contentModeration.settings.reload')).toBeTruthy());

    fireEvent.click(screen.getByText('contentModeration.settings.reload'));
    await waitFor(() =>
      expect(screen.queryByText('contentModeration.settings.conflictTitle')).toBeNull(),
    );
    // Local edits are discarded in favour of the server document, and the CAS base moves on.
    expect(
      (screen.getByText('contentModeration.settings.save') as HTMLButtonElement).disabled,
    ).toBe(true);

    mocks.updateSettings.mockResolvedValue(bundle(10));
    fireEvent.click(screen.getByText('edit-section-basic'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(2));
    expect(mocks.updateSettings.mock.calls[1][0]).toMatchObject({ expectedRevision: 9 });
  });

  it('surfaces a server field rejection next to the classifier instead of a generic failure', async () => {
    // Real tRPC shape: the enterprise body rides in `data.errorData`.
    mocks.updateSettings.mockRejectedValue({
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
    render(<SettingsTab canManage enabled />);
    fireEvent.click(screen.getByText('edit-section-basic'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'contentModeration.errors.reason.endpointChanged',
      ),
    );
    expect(screen.getByTestId('classifier-field-error').textContent).toBe(
      'contentModeration.errors.reason.endpointChanged',
    );
  });
});

describe('SettingsTab — fix round 3', () => {
  it('routes a row-scoped regex rejection to the keyword table', async () => {
    mocks.updateSettings.mockRejectedValue({
      data: {
        errorData: {
          code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
          details: { field: 'keywords', index: 12, reason: 'regex_unsafe' },
        },
      },
      message: 'PLATFORM_CONFIG_VALIDATION_FAILED',
    });
    render(<SettingsTab canManage enabled />);
    fireEvent.click(screen.getByText('edit-section-basic'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));

    await waitFor(() =>
      expect(screen.getByTestId('keywords-field-error').textContent).toBe(
        'contentModeration.errors.reason.regexUnsafe',
      ),
    );
    expect(screen.getByTestId('keywords-field-error-index').textContent).toBe('12');
    // A keyword rejection must not leak into the classifier section.
    expect(screen.getByTestId('classifier-field-error').textContent).toBe('');
  });

  it('routes the batch-limit rejection to the keyword table without a row', async () => {
    mocks.updateSettings.mockRejectedValue({
      data: {
        errorData: {
          code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
          details: { field: 'keywords', reason: 'too_many_regex_changes' },
        },
      },
      message: 'PLATFORM_CONFIG_VALIDATION_FAILED',
    });
    render(<SettingsTab canManage enabled />);
    fireEvent.click(screen.getByText('edit-section-basic'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));

    await waitFor(() =>
      expect(screen.getByTestId('keywords-field-error').textContent).toBe(
        'contentModeration.errors.reason.tooManyRegexChanges',
      ),
    );
    expect(screen.getByTestId('keywords-field-error-index').textContent).toBe('');
  });

  it('clears a previous rejection when the next save is attempted', async () => {
    mocks.updateSettings.mockRejectedValueOnce({
      data: {
        errorData: {
          code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
          details: { field: 'keywords', index: 3, reason: 'regex_slow' },
        },
      },
      message: 'PLATFORM_CONFIG_VALIDATION_FAILED',
    });
    mocks.updateSettings.mockResolvedValue(bundle(5));
    render(<SettingsTab canManage enabled />);
    fireEvent.click(screen.getByText('edit-section-basic'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));
    await waitFor(() =>
      expect(screen.getByTestId('keywords-field-error').textContent).not.toBe(''),
    );

    fireEvent.click(screen.getByText('edit-section-basic'));
    fireEvent.click(screen.getByText('contentModeration.settings.save'));
    await waitFor(() => expect(screen.getByTestId('keywords-field-error').textContent).toBe(''));
  });
});
