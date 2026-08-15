// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { AdminManagedResourcesGetOutput } from '@/server/enterprise/contracts/adminManagedResources';
import type { ManagedResourcePolicyMap } from '@/types/platform/managedResources';

import ManagedResourcesPolicyPage from './ManagedResourcesPolicyPage';

const mocks = vi.hoisted(() => ({
  data: undefined as AdminManagedResourcesGetOutput | undefined,
  /** Ordered side-effect log — asserts the success toast lands at the commit boundary. */
  events: [] as string[],
  guard: vi.fn(),
  mutate: vi.fn(),
  permissions: [] as string[],
  refreshCapabilities: vi.fn(),
  save: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_target, property) => String(property) }),
  cssVar: {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
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
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    loading,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button {...props} disabled={Boolean(props.disabled || loading)} type="button">
      {children}
    </button>
  ),
  Select: ({
    'aria-label': ariaLabel,
    disabled,
    onChange,
    options,
    value,
  }: {
    'aria-label'?: string;
    'disabled'?: boolean;
    'onChange': (value: string) => void;
    'options': { label: ReactNode; value: string }[];
    'value': string;
  }) => (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  toast: { success: mocks.toastSuccess, warning: mocks.toastWarning },
}));

vi.mock('@/components/AsyncBoundary', () => ({
  default: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/Loading/BrandTextLoading', () => ({ default: () => null }));

vi.mock('@/enterprise/client/errors/mapEnterpriseError', () => ({
  mapEnterpriseError: (cause: { code?: string }) =>
    cause?.code ? { code: cause.code, i18nKey: cause.code } : null,
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'better-auth', permissions: mocks.permissions }),
}));

vi.mock('@/enterprise/client/providers/EnterprisePlatformProvider', () => ({
  useEnterprisePlatform: () => ({ refresh: mocks.refreshCapabilities }),
}));

vi.mock('@/enterprise/client/services/adminManagedResources', () => ({
  adminManagedResourcesService: { save: mocks.save },
}));

vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', () => ({
  withAdminReauthRetry: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ banner, children }: { banner?: ReactNode; children?: ReactNode }) => (
    <main>
      {banner}
      {children}
    </main>
  ),
}));

vi.mock('../primitives/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: mocks.guard,
}));

vi.mock('./hooks/useAdminManagedResources', () => ({
  useFetchAdminManagedResources: () => ({
    data: mocks.data,
    error: undefined,
    isLoading: false,
    mutate: mocks.mutate,
  }),
}));

vi.mock('./SharedOAuthAuthorizationControl', () => ({ default: () => null }));
vi.mock('./SidebarLayoutControl', () => ({ default: () => null }));

const policy = (): ManagedResourcePolicyMap => ({
  agents: { enforcementMode: 'observe', managed: false },
  aiModels: { enforcementMode: 'observe', managed: false },
  aiProviders: { enforcementMode: 'observe', managed: false },
  connectors: { enforcementMode: 'observe', managed: false },
  skills: { enforcementMode: 'observe', managed: false },
});

const makeData = (
  baseRevision: number,
  draftToken: string,
  draft: ManagedResourcePolicyMap = policy(),
): AdminManagedResourcesGetOutput => ({
  baseRevision,
  draft,
  draftToken,
  published: policy(),
  readiness: {
    agents: true,
    aiModels: true,
    aiProviders: true,
    connectors: true,
    skills: true,
  },
  status: 'draft',
});

const agentMode = () => screen.getByLabelText('nav.agents managedResources.uiMode.label');

const savePolicyButton = () =>
  screen.getByRole('button', { name: 'managedResources.actions.save' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  mocks.permissions = [
    PLATFORM_PERMISSIONS.POLICY_READ,
    PLATFORM_PERMISSIONS.POLICY_UPDATE,
    PLATFORM_PERMISSIONS.POLICY_PUBLISH,
  ];
  mocks.data = makeData(1, 'a'.repeat(64));
  mocks.mutate.mockImplementation(async () => {
    mocks.events.push('mutate');
    return mocks.data;
  });
  mocks.refreshCapabilities.mockImplementation(async () => {
    mocks.events.push('refreshCapabilities');
  });
  mocks.save.mockImplementation(async () => {
    mocks.events.push('save');
    return { auditId: 'a1', revision: 2, runtimeTransition: 'finalized' };
  });
  mocks.toastSuccess.mockImplementation(() => mocks.events.push('toast.success'));
  mocks.toastWarning.mockImplementation(() => mocks.events.push('toast.warning'));
});

describe('ManagedResourcesPolicyPage integration', () => {
  it('guards an embedded same-path tab switch only while the editor is dirty', async () => {
    const { rerender } = render(<ManagedResourcesPolicyPage embedded />);
    fireEvent.change(agentMode(), { target: { value: 'platform' } });

    const shouldBlock = () => {
      const predicate = mocks.guard.mock.calls.at(-1)?.[0]?.shouldBlock;
      if (typeof predicate !== 'function') throw new TypeError('expected blocker predicate');
      return predicate({
        currentLocation: { pathname: '/admin/unified', search: '?tab=managed' },
        nextLocation: { pathname: '/admin/unified', search: '?tab=settings' },
      });
    };
    await waitFor(() => expect(shouldBlock()).toBe(true));

    rerender(<ManagedResourcesPolicyPage />);
    expect(shouldBlock()).toBe(false);
  });

  it('adopts clean SWR snapshots but never discards unsaved local edits', async () => {
    const { rerender } = render(<ManagedResourcesPolicyPage />);
    const latest = policy();
    latest.agents = { enforcementMode: 'enforced', managed: true };
    mocks.data = makeData(2, 'b'.repeat(64), latest);
    rerender(<ManagedResourcesPolicyPage embedded />);
    await waitFor(() => expect(agentMode()).toHaveValue('platform'));

    fireEvent.change(agentMode(), { target: { value: 'user' } });
    const newer = policy();
    newer.agents = { enforcementMode: 'ui-only', managed: true };
    mocks.data = makeData(3, 'c'.repeat(64), newer);
    rerender(<ManagedResourcesPolicyPage />);

    // Local edit survives the incoming snapshot; the server CAS guards the write itself.
    await waitFor(() => expect(agentMode()).toHaveValue('user'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('applies the policy in one save carrying the CAS revision and token', async () => {
    render(<ManagedResourcesPolicyPage embedded />);
    fireEvent.change(agentMode(), { target: { value: 'platform' } });
    fireEvent.click(screen.getByRole('button', { name: 'managedResources.actions.save' }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({
      draft: expect.objectContaining({
        agents: { enforcementMode: 'enforced', managed: true },
      }),
      expectedDraftToken: 'a'.repeat(64),
      expectedRevision: 1,
    });
    expect(mocks.refreshCapabilities).toHaveBeenCalledTimes(1);
  });

  it('reloads the live policy and explains it when someone else saved first', async () => {
    mocks.save.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { code: 'PLATFORM_REVISION_CONFLICT' }),
    );
    const latest = policy();
    latest.skills = { enforcementMode: 'enforced', managed: true };
    mocks.mutate.mockImplementation(async () => {
      mocks.data = makeData(2, 'b'.repeat(64), latest);
      return mocks.data;
    });

    render(<ManagedResourcesPolicyPage embedded />);
    fireEvent.change(agentMode(), { target: { value: 'platform' } });
    fireEvent.click(screen.getByRole('button', { name: 'managedResources.actions.save' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('managedResources.conflict.reloaded'),
    );
    // Local edit is dropped in favour of the authoritative server policy.
    expect(agentMode()).toHaveValue('user');
    expect(screen.getByLabelText('nav.aiSkills managedResources.uiMode.label')).toHaveValue(
      'platform',
    );
  });

  it('announces the applied policy at the commit boundary, before any refresh', async () => {
    render(<ManagedResourcesPolicyPage embedded />);
    fireEvent.change(agentMode(), { target: { value: 'platform' } });
    fireEvent.click(savePolicyButton());

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('managedResources.saveSuccess');
    expect(mocks.events).toEqual(['save', 'toast.success', 'refreshCapabilities', 'mutate']);
  });

  it('keeps the local edits and retries when the conflict reload fails', async () => {
    mocks.save.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { code: 'PLATFORM_REVISION_CONFLICT' }),
    );
    mocks.mutate.mockRejectedValueOnce(new Error('offline'));

    render(<ManagedResourcesPolicyPage embedded />);
    fireEvent.change(agentMode(), { target: { value: 'platform' } });
    fireEvent.click(savePolicyButton());

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('managedResources.conflict.reloadFailed'),
    );
    // Nothing committed and nothing reloaded — keep the edits instead of claiming a reload.
    expect(screen.queryByText('managedResources.conflict.reloaded')).toBeNull();
    expect(agentMode()).toHaveValue('platform');

    const latest = policy();
    latest.skills = { enforcementMode: 'enforced', managed: true };
    mocks.mutate.mockImplementation(async () => {
      mocks.data = makeData(2, 'b'.repeat(64), latest);
      return mocks.data;
    });
    fireEvent.click(screen.getByRole('button', { name: 'managedResources.conflict.retryReload' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('managedResources.conflict.reloaded'),
    );
    expect(agentMode()).toHaveValue('user');
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('blocks save on a server readiness rejection even when the cached readiness looked ready', async () => {
    mocks.save.mockRejectedValueOnce(
      Object.assign(new Error('not ready'), { code: 'PLATFORM_CONFIG_VALIDATION_FAILED' }),
    );
    const unready = makeData(1, 'a'.repeat(64));
    mocks.mutate.mockImplementation(async () => {
      mocks.data = { ...unready, readiness: { ...unready.readiness, agents: false } };
      return mocks.data;
    });

    render(<ManagedResourcesPolicyPage embedded />);
    fireEvent.change(agentMode(), { target: { value: 'platform' } });
    fireEvent.click(savePolicyButton());

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('managedResources.readiness.blocked'),
    );
    expect(savePolicyButton()).toBeDisabled();
    // The generic enterprise validation message must not stand in for the readiness gate.
    expect(screen.queryByText('PLATFORM_CONFIG_VALIDATION_FAILED')).toBeNull();
  });

  it('disables save again once an edit is reverted', async () => {
    render(<ManagedResourcesPolicyPage embedded />);
    expect(savePolicyButton()).toBeDisabled();

    fireEvent.change(agentMode(), { target: { value: 'platform' } });
    await waitFor(() => expect(savePolicyButton()).toBeEnabled());

    fireEvent.change(agentMode(), { target: { value: 'user' } });
    await waitFor(() => expect(savePolicyButton()).toBeDisabled());
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('applies a legacy stranded draft with a single save', async () => {
    const stranded = policy();
    stranded.skills = { enforcementMode: 'enforced', managed: true };
    // Loaded from the server, never edited here: the editable state already diverges.
    mocks.data = makeData(1, 'a'.repeat(64), stranded);

    render(<ManagedResourcesPolicyPage embedded />);
    await waitFor(() => expect(savePolicyButton()).toBeEnabled());
    fireEvent.click(savePolicyButton());

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({
      draft: expect.objectContaining({ skills: { enforcementMode: 'enforced', managed: true } }),
    });
  });

  it('blocks save while an enforced resource is not ready', async () => {
    mocks.data = {
      ...makeData(1, 'a'.repeat(64)),
      readiness: {
        agents: false,
        aiModels: true,
        aiProviders: true,
        connectors: true,
        skills: true,
      },
    };
    render(<ManagedResourcesPolicyPage embedded />);
    fireEvent.change(agentMode(), { target: { value: 'platform' } });

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('managedResources.readiness.blocked'),
    );
    expect(screen.getByRole('button', { name: 'managedResources.actions.save' })).toBeDisabled();
  });
});
