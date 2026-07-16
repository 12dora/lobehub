// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { CONFLICT_DRAFT_KEY } from './settingsPolicyController';
import SettingsPolicyPage from './SettingsPolicyPage';

const mocks = vi.hoisted(() => ({
  blocker: { proceed: vi.fn(), reset: vi.fn(), state: 'unblocked' },
  capability: true,
  data: undefined as any,
  mutate: vi.fn(),
  permissions: [] as string[],
  saveDraft: vi.fn(),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_target, property) => String(property) }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ description, message }: { description?: ReactNode; message?: ReactNode }) => (
    <div role="alert">
      {message}
      {description}
    </div>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Input: (props: any) => <input {...props} />,
  Text: ({ as: Component = 'span', children, ...props }: any) => (
    <Component {...props}>{children}</Component>
  ),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, loading, type: _type, ...props }: any) => (
    <button {...props} disabled={props.disabled || loading}>
      {children}
    </button>
  ),
  Select: ({ disabled, onChange, options, value }: any) => (
    <select
      aria-label="policy-mode"
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
  Switch: ({ checked, disabled, onChange }: any) => (
    <input
      aria-label="visibility-toggle"
      checked={checked}
      disabled={disabled}
      type="checkbox"
      onChange={(event) => onChange?.(event.target.checked)}
    />
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join('|')}` : key,
  }),
}));

vi.mock('react-router', () => ({
  useBlocker: (dirty: boolean) =>
    dirty && mocks.blocker.state === 'blocked'
      ? mocks.blocker
      : { proceed: vi.fn(), reset: vi.fn(), state: 'unblocked' },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ permissions: mocks.permissions }),
}));

vi.mock('@/enterprise/client/providers/EnterprisePlatformProvider', () => ({
  useEnterprisePlatform: () => ({
    capabilities: { userSettingsPolicyEnabled: mocks.capability },
  }),
}));

vi.mock('@/enterprise/client/services/adminSettings', () => ({
  adminSettingsService: {
    publish: vi.fn(),
    rollback: vi.fn(),
    saveDraft: mocks.saveDraft,
    validateDraft: vi.fn().mockResolvedValue({
      impactEstimate: { pathsWithOverrides: 0, totalOverrideRows: 0 },
      issues: [],
      ok: true,
    }),
  },
}));

vi.mock('@/enterprise/client/errors/mapEnterpriseError', () => ({
  mapEnterpriseError: (error: { code?: string }) =>
    error?.code ? { code: error.code, i18nKey: 'settingsPolicy.error' } : null,
}));

vi.mock('./hooks/useAdminSettings', () => ({
  refreshAdminSettingsDraft: vi.fn(),
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
  default: ({ actions, banner, children, description, title, toolbar }: any) => (
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      {actions}
      {banner}
      {toolbar}
      {children}
    </main>
  ),
}));

vi.mock('../users/modals/openReasonModal', () => ({ openReasonModal: vi.fn() }));

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
  status: 'draft' as const,
});

describe('SettingsPolicyPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.capability = true;
    mocks.data = makeData(1);
    mocks.mutate.mockReset();
    mocks.permissions = [];
    mocks.saveDraft.mockReset();
    mocks.blocker.state = 'unblocked';
    mocks.blocker.proceed.mockReset();
    mocks.blocker.reset.mockReset();
  });

  it.each([
    ['viewer', [PLATFORM_PERMISSIONS.SETTINGS_READ], true, false, false],
    [
      'publisher-only',
      [PLATFORM_PERMISSIONS.SETTINGS_READ, PLATFORM_PERMISSIONS.SETTINGS_PUBLISH],
      true,
      true,
      false,
    ],
    [
      'update-only',
      [PLATFORM_PERMISSIONS.SETTINGS_READ, PLATFORM_PERMISSIONS.SETTINGS_UPDATE],
      false,
      false,
      true,
    ],
  ])(
    'enforces the %s component permission matrix',
    async (_role, permissions, editorsDisabled, canValidate, canSave) => {
      mocks.permissions = permissions as string[];
      render(<SettingsPolicyPage />);
      const editor = await screen.findByLabelText('editor-font.title:general.fontSize');
      expect(editor).toHaveProperty('disabled', editorsDisabled);
      expect(screen.getByLabelText('policy-mode')).toHaveProperty('disabled', editorsDisabled);
      expect(screen.getByLabelText('visibility-toggle')).toHaveProperty(
        'disabled',
        editorsDisabled,
      );
      const validate = screen.queryByRole('button', { name: 'settingsPolicy.validate' });
      expect(validate !== null).toBe(canValidate);
      if (canValidate) expect(validate).toBeEnabled();

      if (canSave) {
        fireEvent.change(editor, { target: { value: 'local' } });
        expect(
          await screen.findByRole('button', { name: 'settingsPolicy.saveDraft' }),
        ).toBeEnabled();
      } else {
        expect(screen.queryByRole('button', { name: 'settingsPolicy.saveDraft' })).toBeNull();
      }
      expect(screen.queryByRole('button', { name: 'settingsPolicy.publish' })).toBeNull();
    },
  );

  it('blocks stale save, fetches the latest base, persists conflict, and requires rebase', async () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.SETTINGS_READ,
      PLATFORM_PERMISSIONS.SETTINGS_UPDATE,
      PLATFORM_PERMISSIONS.SETTINGS_PUBLISH,
    ];
    const revisionError = Object.assign(new Error('stale'), {
      code: 'PLATFORM_REVISION_CONFLICT',
    });
    mocks.saveDraft
      .mockRejectedValueOnce(revisionError)
      .mockResolvedValueOnce({
        baseRevision: 2,
        draftToken: savedDraftToken,
        ok: true,
        registryVersion: 1,
      })
      .mockResolvedValueOnce({
        baseRevision: 2,
        draftToken: 'd'.repeat(64),
        ok: true,
        registryVersion: 1,
      });
    let refreshCount = 0;
    mocks.mutate.mockImplementation(async () => {
      refreshCount += 1;
      mocks.data =
        refreshCount === 1
          ? makeData(2, 'server', latestDraftToken)
          : makeData(2, 'local', savedDraftToken);
      return mocks.data;
    });

    render(<SettingsPolicyPage />);
    fireEvent.change(await screen.findByLabelText('editor-font.title:general.fontSize'), {
      target: { value: 'local' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'settingsPolicy.saveDraft' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('settingsPolicy.conflict.title');
    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);
    expect(mocks.saveDraft.mock.calls[0]?.[0].expectedDraftToken).toBe(draftToken);
    expect(window.localStorage.getItem(CONFLICT_DRAFT_KEY)).toContain('"previousBaseRevision":1');
    expect(screen.queryByRole('button', { name: 'settingsPolicy.saveDraft' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settingsPolicy.conflict.rebase' }));
    expect(screen.queryByRole('alert')).toBeNull();
    const save = await screen.findByRole('button', { name: 'settingsPolicy.saveDraft' });
    fireEvent.click(save);
    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledTimes(2));
    expect(mocks.saveDraft.mock.calls[1]?.[0].expectedDraftToken).toBe(latestDraftToken);
    expect(window.localStorage.getItem(CONFLICT_DRAFT_KEY)).toBeNull();

    await waitFor(() => expect(mocks.data.draftToken).toBe(savedDraftToken));
    fireEvent.change(screen.getByLabelText('editor-font.title:general.fontSize'), {
      target: { value: 'local-again' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'settingsPolicy.saveDraft' }));
    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledTimes(3));
    expect(mocks.saveDraft.mock.calls[2]?.[0].expectedDraftToken).toBe(savedDraftToken);
  });

  it('keeps rebase and discard blocked when latest refresh fails, then retries without a loop', async () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.SETTINGS_READ, PLATFORM_PERMISSIONS.SETTINGS_UPDATE];
    mocks.saveDraft.mockRejectedValueOnce(
      Object.assign(new Error('stale token'), { code: 'PLATFORM_REVISION_CONFLICT' }),
    );
    mocks.mutate.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async () => {
      mocks.data = makeData(1, 'server', latestDraftToken);
      return mocks.data;
    });

    render(<SettingsPolicyPage />);
    fireEvent.change(await screen.findByLabelText('editor-font.title:general.fontSize'), {
      target: { value: 'local' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'settingsPolicy.saveDraft' }));

    expect(await screen.findByText('settingsPolicy.conflict.latestUnavailable')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'settingsPolicy.conflict.rebase' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'settingsPolicy.conflict.discard' })).toBeNull();
    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'settingsPolicy.conflict.retryRefresh' }));
    expect(
      await screen.findByRole('button', { name: 'settingsPolicy.conflict.rebase' }),
    ).toBeEnabled();
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    expect(mocks.saveDraft).toHaveBeenCalledTimes(1);
  });

  it('protects dirty drafts from SPA navigation', async () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.SETTINGS_READ, PLATFORM_PERMISSIONS.SETTINGS_UPDATE];
    mocks.blocker.state = 'blocked';
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SettingsPolicyPage />);
    fireEvent.change(await screen.findByLabelText('editor-font.title:general.fontSize'), {
      target: { value: 'local' },
    });
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(mocks.blocker.reset).toHaveBeenCalled();
  });
});
