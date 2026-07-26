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
  guard: vi.fn(),
  mutate: vi.fn(),
  permissions: [] as string[],
  publish: vi.fn(),
  saveDraft: vi.fn(),
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
  toast: { warning: vi.fn() },
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
  useEnterprisePlatform: () => ({ refresh: vi.fn() }),
}));

vi.mock('@/enterprise/client/services/adminManagedResources', () => ({
  adminManagedResourcesService: {
    publish: mocks.publish,
    saveDraft: mocks.saveDraft,
  },
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permissions = [
    PLATFORM_PERMISSIONS.POLICY_READ,
    PLATFORM_PERMISSIONS.POLICY_UPDATE,
    PLATFORM_PERMISSIONS.POLICY_PUBLISH,
  ];
  mocks.data = makeData(1, 'a'.repeat(64));
  mocks.mutate.mockImplementation(async () => mocks.data);
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

  it('adopts clean SWR snapshots and preserves dirty values as an explicit conflict', async () => {
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

    await waitFor(() => expect(agentMode()).toHaveValue('user'));
    expect(screen.getByRole('alert')).toHaveTextContent('managedResources.conflict.title');
  });

  it('obtains the latest CAS token before offering keep-local after a field conflict', async () => {
    const conflict = Object.assign(new Error('conflict'), {
      code: 'PLATFORM_REVISION_CONFLICT',
    });
    mocks.saveDraft
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ baseRevision: 3, draftToken: 'd'.repeat(64), ok: true });
    const latest = policy();
    latest.agents = { enforcementMode: 'ui-only', managed: true };
    mocks.mutate.mockImplementation(async () => {
      mocks.data = makeData(2, 'b'.repeat(64), latest);
      return mocks.data;
    });

    render(<ManagedResourcesPolicyPage embedded />);
    fireEvent.change(agentMode(), { target: { value: 'platform' } });
    fireEvent.click(screen.getByRole('button', { name: 'managedResources.actions.save' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('managedResources.conflict.title'),
    );
    expect(
      screen.queryByRole('button', { name: 'managedResources.conflict.keepLocal' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'managedResources.conflict.rebase' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'managedResources.conflict.keepLocal' }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'managedResources.conflict.keepLocal' }));
    fireEvent.click(screen.getByRole('button', { name: 'managedResources.actions.save' }));

    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledTimes(2));
    expect(mocks.saveDraft.mock.calls[1]?.[0]).toMatchObject({
      expectedDraftToken: 'b'.repeat(64),
    });
  });
});
