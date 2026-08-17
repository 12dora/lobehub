// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import SettingsPolicyPage from './SettingsPolicyPage';

const mocks = vi.hoisted(() => {
  const defaultT = (key: string, values?: Record<string, unknown>) => {
    if (key === 'settingsPolicy.unknownSetting') return `Setting ${values?.index}`;
    return values ? `${key}:${Object.values(values).join('|')}` : key;
  };
  return {
    blocker: { proceed: vi.fn(), reset: vi.fn(), state: 'unblocked' },
    capability: true,
    createModal: vi.fn((_options: { onOpenChange?: (open: boolean) => void }) => ({
      close: vi.fn(),
      destroy: vi.fn(),
    })),
    data: undefined as any,
    defaultT,
    mutate: vi.fn(),
    openDangerConfirm: vi.fn(),
    permissions: [] as string[],
    refreshAdminSettingsDraft: vi.fn(),
    save: vi.fn(),
    /** Overridable translation mock (ASI-006 zh-CN search guard). */
    t: defaultT as (key: string, values?: Record<string, unknown>) => string,
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    useBlocker: vi.fn((when: boolean | ((args: unknown) => boolean)) => {
      const enabled = typeof when === 'function' ? true : Boolean(when);
      return enabled && mocks.blocker.state === 'blocked'
        ? mocks.blocker
        : { proceed: vi.fn(), reset: vi.fn(), state: 'unblocked' };
    }),
    /** Spy only — the module mock below runs `fn` once. */
    withAdminReauthRetry: vi.fn(),
  };
});

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_target, property) => String(property) }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => {
  const Skeleton = Object.assign(
    ({ children, ...rest }: any) => (
      <div data-testid="skeleton" {...rest}>
        {children}
      </div>
    ),
    {
      Block: (props: any) => <div data-testid="skeleton-block" {...props} />,
      Button: (props: any) => <div data-testid="skeleton-button" {...props} />,
    },
  );
  return {
    Alert: ({
      description,
      extra,
      message,
    }: {
      description?: ReactNode;
      extra?: ReactNode;
      message?: ReactNode;
    }) => (
      <div role="alert">
        {message}
        {description}
        {extra}
      </div>
    ),
    Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Input: (props: any) => <input {...props} />,
    Skeleton,
    Text: ({ as: Component = 'span', children, ...props }: any) => (
      <Component {...props}>{children}</Component>
    ),
  };
});

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, loading, type: _type, ...props }: any) => (
    <button {...props} disabled={props.disabled || loading}>
      {children}
    </button>
  ),
  Select: ({ 'aria-label': ariaLabel, disabled, onChange, options, value }: any) => (
    <select
      aria-label={ariaLabel ?? 'policy-mode'}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {options?.map((option: any) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  createModal: mocks.createModal,
  ModalFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock('../primitives/DangerConfirm', () => ({ openDangerConfirm: mocks.openDangerConfirm }));

vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => ({
  withAdminReauthRetry: (fn: () => Promise<unknown>, options?: { authMethod?: string | null }) => {
    mocks.withAdminReauthRetry(fn, options);
    return fn();
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => mocks.t(key, values),
  }),
}));

vi.mock('react-router', () => ({
  useBlocker: mocks.useBlocker,
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'better-auth', permissions: mocks.permissions }),
}));

vi.mock('@/enterprise/client/providers/EnterprisePlatformProvider', () => ({
  useEnterprisePlatform: () => ({
    capabilities: { userSettingsPolicyEnabled: mocks.capability },
  }),
}));

vi.mock('@/enterprise/client/services/adminSettings', () => ({
  adminSettingsService: { save: mocks.save },
}));

vi.mock('@/enterprise/client/errors/mapEnterpriseError', () => ({
  mapEnterpriseError: (error: { code?: string }) =>
    error?.code ? { code: error.code, i18nKey: 'settingsPolicy.error' } : null,
}));

vi.mock('./hooks/useAdminSettings', () => ({
  refreshAdminSettingsDraft: mocks.refreshAdminSettingsDraft,
  useFetchAdminSettingsDraft: () => ({
    data: mocks.data,
    error: undefined,
    isLoading: false,
    mutate: mocks.mutate,
  }),
}));

vi.mock('./PolicyValueEditor', () => ({
  PolicyValueEditor: ({ disabled, label, onChange, value }: any) => (
    <input
      aria-label={`editor-${label}`}
      disabled={disabled}
      value={String(value ?? '')}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ actions, banner, children, description, notice, title, toolbar }: any) => (
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      <div data-testid="page-notice">{notice}</div>
      {actions}
      {banner}
      <div data-testid="page-toolbar">{toolbar}</div>
      {children}
    </main>
  ),
}));

const oldPolicy = {
  mode: 'default' as const,
  schemaVersion: 1,
  value: 'old',
  visibility: 'visible' as const,
};
const draftToken = 'a'.repeat(64);
const latestDraftToken = 'b'.repeat(64);
const savedDraftToken = 'c'.repeat(64);

const makeData = (baseRevision: number, value = 'old', token = draftToken) => ({
  baseRevision,
  draft: { 'general.fontSize': { ...oldPolicy, value } },
  draftToken: token,
  publishedPolicies: { 'general.fontSize': { ...oldPolicy, value } },
  registry: [
    {
      control: 'text',
      descriptionKey: 'font.desc',
      group: 'general',
      path: 'general.fontSize',
      schemaVersion: 1,
      titleKey: 'font.title',
    },
  ],
  registryVersion: 1,
  status: 'published' as const,
});

const FULL_ACCESS = [
  PLATFORM_PERMISSIONS.SETTINGS_READ,
  PLATFORM_PERMISSIONS.SETTINGS_UPDATE,
  PLATFORM_PERMISSIONS.SETTINGS_PUBLISH,
];

const editor = () => screen.getByLabelText('editor-font.title:Setting 1');
const saveButton = () => screen.getByRole('button', { name: 'settingsPolicy.save' });

describe('SettingsPolicyPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.capability = true;
    mocks.data = makeData(1);
    mocks.mutate.mockReset();
    mocks.openDangerConfirm.mockReset();
    mocks.permissions = [];
    mocks.refreshAdminSettingsDraft.mockReset();
    mocks.refreshAdminSettingsDraft.mockResolvedValue(undefined);
    mocks.save.mockReset();
    mocks.save.mockResolvedValue({
      auditId: 'audit-1',
      draftToken: savedDraftToken,
      revision: 2,
    });
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.withAdminReauthRetry.mockClear();
    mocks.t = mocks.defaultT;
    mocks.blocker.state = 'unblocked';
    mocks.blocker.proceed.mockReset();
    mocks.blocker.reset.mockReset();
    mocks.useBlocker.mockClear();
  });

  it.each([
    ['viewer', [PLATFORM_PERMISSIONS.SETTINGS_READ], false],
    [
      'update-only (cannot apply site-wide)',
      [PLATFORM_PERMISSIONS.SETTINGS_READ, PLATFORM_PERMISSIONS.SETTINGS_UPDATE],
      false,
    ],
    [
      'publish-only (cannot edit)',
      [PLATFORM_PERMISSIONS.SETTINGS_READ, PLATFORM_PERMISSIONS.SETTINGS_PUBLISH],
      false,
    ],
    ['settings admin', FULL_ACCESS, true],
  ])('enforces the %s permission matrix', async (_role, permissions, canSave) => {
    mocks.permissions = permissions as string[];
    render(<SettingsPolicyPage />);

    expect(await screen.findByLabelText('editor-font.title:Setting 1')).toHaveProperty(
      'disabled',
      !canSave,
    );
    expect(screen.getByLabelText('settingsPolicy.uiMode.label')).toHaveProperty(
      'disabled',
      !canSave,
    );
    if (canSave) {
      expect(saveButton()).toBeDisabled();
      fireEvent.change(editor(), { target: { value: 'local' } });
      await waitFor(() => expect(saveButton()).toBeEnabled());
    } else {
      expect(screen.queryByRole('button', { name: 'settingsPolicy.save' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'settingsPolicy.resetDefaults' })).toBeNull();
    }
  });

  it('applies owned policies in one CAS-guarded save with step-up auth', async () => {
    mocks.permissions = FULL_ACCESS;
    render(<SettingsPolicyPage />);
    fireEvent.change(await screen.findByLabelText('editor-font.title:Setting 1'), {
      target: { value: 'kept' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const payload = mocks.save.mock.calls[0]?.[0];
    // Legacy `default` mode is normalized to the two-state platform form on write.
    expect(payload.policies['general.fontSize']).toMatchObject({
      mode: 'locked',
      value: 'kept',
      visibility: 'hidden',
    });
    expect(payload).toMatchObject({
      expectedDraftToken: draftToken,
      expectedRevision: 1,
      reason: 'settingsPolicy.saveReason',
    });
    expect(mocks.withAdminReauthRetry).toHaveBeenCalledTimes(1);
    expect(mocks.withAdminReauthRetry.mock.calls[0]?.[1]).toMatchObject({
      authMethod: 'better-auth',
    });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.refreshAdminSettingsDraft).toHaveBeenCalled();
  });

  it('reloads the live policy and explains it when someone else saved first', async () => {
    mocks.permissions = FULL_ACCESS;
    mocks.save.mockRejectedValueOnce(
      Object.assign(new Error('stale'), { code: 'PLATFORM_REVISION_CONFLICT' }),
    );
    mocks.mutate.mockImplementation(async () => {
      mocks.data = makeData(2, 'server-wins', latestDraftToken);
      return mocks.data;
    });

    const { rerender } = render(<SettingsPolicyPage />);
    fireEvent.change(await screen.findByLabelText('editor-font.title:Setting 1'), {
      target: { value: 'mine' },
    });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('settingsPolicy.conflict.reloaded'),
    );
    rerender(<SettingsPolicyPage />);
    // Local edits are dropped for the authoritative server values (no rebase state machine).
    await waitFor(() => expect(editor()).toHaveValue('server-wins'));
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('keeps the local edits, explains the failure and retries when the conflict reload fails', async () => {
    mocks.permissions = FULL_ACCESS;
    mocks.save.mockRejectedValueOnce(
      Object.assign(new Error('stale'), { code: 'PLATFORM_REVISION_CONFLICT' }),
    );
    mocks.mutate.mockRejectedValueOnce(new Error('offline'));

    const { rerender } = render(<SettingsPolicyPage />);
    fireEvent.change(await screen.findByLabelText('editor-font.title:Setting 1'), {
      target: { value: 'mine' },
    });
    fireEvent.click(saveButton());

    // Nothing committed and nothing reloaded — never claim the latest values were loaded.
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('settingsPolicy.conflict.reloadFailed'),
    );
    expect(screen.queryByText('settingsPolicy.conflict.reloaded')).toBeNull();
    expect(screen.queryByText('settingsPolicy.refresh.committedTitle')).toBeNull();
    expect(editor()).toHaveValue('mine');

    mocks.mutate.mockImplementation(async () => {
      mocks.data = makeData(2, 'server-wins', latestDraftToken);
      return mocks.data;
    });
    fireEvent.click(screen.getByRole('button', { name: 'settingsPolicy.conflict.retryReload' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('settingsPolicy.conflict.reloaded'),
    );
    rerender(<SettingsPolicyPage />);
    await waitFor(() => expect(editor()).toHaveValue('server-wins'));
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('applies a legacy stranded draft with a single save', async () => {
    mocks.permissions = FULL_ACCESS;
    mocks.data = {
      ...makeData(1),
      // Loaded from the server, never edited here: the editable state already diverges.
      draft: { 'general.fontSize': { ...oldPolicy, value: 'stranded' } },
    };
    render(<SettingsPolicyPage />);

    expect(await screen.findByLabelText('editor-font.title:Setting 1')).toHaveValue('stranded');
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.click(saveButton());

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0]?.[0].policies['general.fontSize']).toMatchObject({
      value: 'stranded',
    });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
  });

  it('disables save again once an edit is reverted', async () => {
    mocks.permissions = FULL_ACCESS;
    render(<SettingsPolicyPage />);
    fireEvent.change(await screen.findByLabelText('editor-font.title:Setting 1'), {
      target: { value: 'edited' },
    });
    await waitFor(() => expect(saveButton()).toBeEnabled());

    fireEvent.change(editor(), { target: { value: 'old' } });
    await waitFor(() => expect(saveButton()).toBeDisabled());
    expect(screen.getByText('settingsPolicy.upToDate')).toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('reports a failed save without clearing the pending edits', async () => {
    mocks.permissions = FULL_ACCESS;
    mocks.save.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'PLATFORM_BOOM' }));
    render(<SettingsPolicyPage />);
    fireEvent.change(await screen.findByLabelText('editor-font.title:Setting 1'), {
      target: { value: 'mine' },
    });
    fireEvent.click(saveButton());

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(screen.getByText(/settingsPolicy.error/)).toBeInTheDocument();
    expect(editor()).toHaveValue('mine');
  });

  it('restores defaults with a single empty-owned save behind a confirmation', async () => {
    mocks.permissions = FULL_ACCESS;
    render(<SettingsPolicyPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'settingsPolicy.resetDefaults' }));

    expect(mocks.openDangerConfirm).toHaveBeenCalledTimes(1);
    await act(async () => {
      await mocks.openDangerConfirm.mock.calls[0]![0].onConfirm();
    });

    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0]?.[0]).toEqual({
      expectedDraftToken: draftToken,
      expectedRevision: 1,
      policies: {},
      reason: 'settingsPolicy.resetReason',
    });
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it('keeps restore-defaults in the filter toolbar next to the search box', async () => {
    mocks.permissions = FULL_ACCESS;
    render(<SettingsPolicyPage />);
    const toolbar = await screen.findByTestId('page-toolbar');
    expect(
      within(toolbar).getByRole('button', { name: 'settingsPolicy.resetDefaults' }),
    ).toBeInTheDocument();
    expect(within(toolbar).getByPlaceholderText('settingsPolicy.searchPlaceholder')).toBeTruthy();
  });

  it('disables restore-defaults when the only published overrides belong to the service-model page', async () => {
    mocks.permissions = FULL_ACCESS;
    const foreign = { ...oldPolicy, value: 'gpt-4o' };
    mocks.data = {
      ...makeData(1),
      draft: { 'defaultAgent.config.model': foreign },
      publishedPolicies: { 'defaultAgent.config.model': foreign },
    };
    render(<SettingsPolicyPage />);
    expect(
      await screen.findByRole('button', { name: 'settingsPolicy.resetDefaults' }),
    ).toBeDisabled();
  });

  it('surfaces a failed post-commit refresh as retry-only, never as a failed save', async () => {
    mocks.permissions = FULL_ACCESS;
    mocks.mutate.mockRejectedValue(new Error('offline'));
    render(<SettingsPolicyPage />);
    fireEvent.change(await screen.findByLabelText('editor-font.title:Setting 1'), {
      target: { value: 'kept' },
    });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('settingsPolicy.refresh.committedTitle'),
    );
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(screen.getByText('settingsPolicy.saveState.saved')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'settingsPolicy.refresh.retry' }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2));
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('prunes local drafts left behind by the pre-de-draft editor', async () => {
    mocks.permissions = FULL_ACCESS;
    window.localStorage.setItem('aihub.admin.settings.draft:v1:r1', '{"draft":{}}');
    window.localStorage.setItem('aihub.admin.settings.conflictDraft', '{"draft":{}}');
    window.localStorage.setItem('aihub.admin.other', 'keep');

    render(<SettingsPolicyPage />);
    await screen.findByLabelText('editor-font.title:Setting 1');

    expect(window.localStorage.getItem('aihub.admin.settings.draft:v1:r1')).toBeNull();
    expect(window.localStorage.getItem('aihub.admin.settings.conflictDraft')).toBeNull();
    expect(window.localStorage.getItem('aihub.admin.other')).toBe('keep');
  });

  it('adopts newer server snapshots when clean and keeps local edits when dirty', async () => {
    mocks.permissions = FULL_ACCESS;
    const { rerender } = render(<SettingsPolicyPage />);
    await screen.findByLabelText('editor-font.title:Setting 1');

    mocks.data = makeData(2, 'server-clean', latestDraftToken);
    rerender(<SettingsPolicyPage embedded />);
    await waitFor(() => expect(editor()).toHaveValue('server-clean'));

    fireEvent.change(editor(), { target: { value: 'local-dirty' } });
    mocks.data = makeData(3, 'server-newer', savedDraftToken);
    rerender(<SettingsPolicyPage />);

    await waitFor(() => expect(editor()).toHaveValue('local-dirty'));
  });

  it('protects dirty edits from SPA navigation', async () => {
    mocks.permissions = FULL_ACCESS;
    mocks.blocker.state = 'blocked';
    render(<SettingsPolicyPage />);
    fireEvent.change(await screen.findByLabelText('editor-font.title:Setting 1'), {
      target: { value: 'local' },
    });
    await waitFor(() => expect(mocks.createModal).toHaveBeenCalled());
    act(() => mocks.createModal.mock.calls[0]![0].onOpenChange?.(false));
    expect(mocks.blocker.reset).toHaveBeenCalled();
  });

  it('only guards the exit while the editor actually diverges from the published policy', async () => {
    mocks.permissions = FULL_ACCESS;
    render(<SettingsPolicyPage />);
    await screen.findByLabelText('editor-font.title:Setting 1');

    // The latest blocker predicate, evaluated for a real cross-page navigation.
    const blocksPageExit = () => {
      const shouldBlock = mocks.useBlocker.mock.calls.at(-1)?.[0];
      if (typeof shouldBlock !== 'function') throw new TypeError('expected a blocker predicate');
      return shouldBlock({
        currentLocation: { pathname: '/admin/unified' },
        nextLocation: { pathname: '/admin/users' },
      });
    };

    expect(blocksPageExit()).toBe(false);
    fireEvent.change(editor(), { target: { value: 'edited' } });
    await waitFor(() => expect(blocksPageExit()).toBe(true));
    // Reverting leaves no effective change → stop nagging even though `dirty` stays set.
    fireEvent.change(editor(), { target: { value: 'old' } });
    await waitFor(() => expect(blocksPageExit()).toBe(false));
  });

  it('guards embedded same-path tab switches while preserving standalone query changes', async () => {
    mocks.permissions = FULL_ACCESS;
    const { rerender } = render(<SettingsPolicyPage embedded />);
    fireEvent.change(await screen.findByLabelText('editor-font.title:Setting 1'), {
      target: { value: 'edited' },
    });

    const evaluateLatestBlocker = () => {
      const shouldBlock = mocks.useBlocker.mock.calls.at(-1)?.[0];
      if (typeof shouldBlock !== 'function') throw new TypeError('expected a blocker predicate');
      return shouldBlock({
        currentLocation: { pathname: '/admin/unified', search: '?tab=settings' },
        nextLocation: { pathname: '/admin/unified', search: '?tab=managed' },
      });
    };

    await waitFor(() => expect(evaluateLatestBlocker()).toBe(true));

    rerender(<SettingsPolicyPage />);
    await waitFor(() => expect(evaluateLatestBlocker()).toBe(false));
  });

  it('finds settings by translated Chinese title (ASI-006)', async () => {
    mocks.permissions = FULL_ACCESS;
    mocks.data = {
      ...makeData(1),
      registry: [
        {
          control: 'text',
          descriptionKey: 'setting.fontSize.desc',
          group: 'general',
          path: 'general.fontSize',
          schemaVersion: 1,
          titleKey: 'setting.fontSize',
        },
      ],
    };
    // Map the title key to Chinese — key-equality mocks cannot catch this regression.
    mocks.t = (key, values) => {
      if (key === 'setting.fontSize') return '字体大小';
      return mocks.defaultT(key, values);
    };

    render(<SettingsPolicyPage />);
    expect(await screen.findByLabelText('editor-字体大小')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('settingsPolicy.searchPlaceholder'), {
      target: { value: '字体大小' },
    });
    expect(screen.getByLabelText('editor-字体大小')).toBeTruthy();
    expect(screen.queryByText('settingsPolicy.noResults')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('settingsPolicy.searchPlaceholder'), {
      target: { value: '不存在的设置' },
    });
    expect(screen.queryByLabelText('editor-字体大小')).toBeNull();
    expect(screen.getByText('settingsPolicy.noResults')).toBeTruthy();
  });

  it('uses a localized safe label when registry title metadata is missing', async () => {
    const sentinelPath = 'machine.private.sentinel';
    mocks.permissions = FULL_ACCESS;
    mocks.data = {
      ...makeData(1),
      draft: { [sentinelPath]: oldPolicy },
      publishedPolicies: { [sentinelPath]: oldPolicy },
      registry: [
        {
          control: 'text',
          descriptionKey: 'missing.description',
          group: 'general',
          path: sentinelPath,
          schemaVersion: 1,
          titleKey: 'missing.title',
        },
      ],
    };
    mocks.t = (key, values) => {
      if (key === 'settingsPolicy.unknownSetting') return `Localized setting ${values?.index}`;
      if (key === 'missing.title' || key === 'missing.description') {
        return String(values?.defaultValue ?? '');
      }
      return mocks.defaultT(key, values);
    };

    const { container } = render(<SettingsPolicyPage />);

    expect(await screen.findByText('Localized setting 1')).toBeInTheDocument();
    expect(screen.getByLabelText('editor-Localized setting 1')).toBeInTheDocument();
    expect(container.textContent).not.toContain(sentinelPath);
  });

  it('issues no request and renders a disabled surface when the capability is off', async () => {
    mocks.permissions = FULL_ACCESS;
    mocks.capability = false;
    render(<SettingsPolicyPage />);
    expect(await screen.findByText('settingsPolicy.featureDisabled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'settingsPolicy.save' })).toBeNull();
  });
});
