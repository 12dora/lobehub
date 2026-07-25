/**
 * Legal-hold release interaction: reason modal payload reaches releaseLegalHold.
 * Create-hold user picker must not fire AUDIT_READ search for hold-only actors.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LegalHoldsPage from './LegalHoldsPage';

const releaseLegalHold = vi.fn();
const openAuditReasonModal = vi.fn();
const holdsAccess = vi.hoisted(() => ({
  permissions: ['platform_audit:legal_hold_manage:all'] as string[],
  searchEnabled: [] as boolean[],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Modal: ({ children, open }: { children?: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="modal">{children}</div> : null,
  Select: ({ onChange, value }: { onChange?: (v: string) => void; value?: string }) => (
    <select data-testid="select" value={value ?? ''} onChange={(e) => onChange?.(e.target.value)}>
      <option value="user">user</option>
      <option value="global">global</option>
    </select>
  ),
}));

vi.mock('antd', () => ({
  DatePicker: () => <div data-testid="datepicker" />,
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: 'better-auth',
    permissions: holdsAccess.permissions,
    roles: [],
  }),
}));

vi.mock('../hooks/useAdminAudit', () => ({
  useAdminAuditMutations: () => ({
    createLegalHold: vi.fn(),
    releaseLegalHold: (...args: unknown[]) => releaseLegalHold(...args),
  }),
  useFetchAuditHoldsList: () => ({
    data: {
      items: [
        {
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          expiresAt: null,
          id: 'hold-9',
          reason: 'litigation',
          scopeId: 'user-1',
          scopeType: 'user',
          status: 'active',
        },
      ],
      nextCursor: null,
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  }),
}));

vi.mock('../shared/openAuditReasonModal', () => ({
  openAuditReasonModal: (opts: {
    buildPayload: (reason: string) => unknown;
    onSubmit: (payload: unknown) => Promise<void>;
  }) => openAuditReasonModal(opts),
}));

vi.mock('../shared/AuditUserSearchSelect', () => ({
  default: ({ enabled }: { enabled?: boolean }) => {
    holdsAccess.searchEnabled.push(enabled !== false);
    return <div data-enabled={enabled !== false ? '1' : '0'} data-testid="user-search" />;
  },
}));

vi.mock('../shared/AuditStatusTag', () => ({
  default: ({ value }: { value?: string }) => <span>{value}</span>,
}));

vi.mock('../../primitives/AdminPageTemplate', () => ({
  default: ({
    actions,
    children,
    title,
  }: {
    actions?: React.ReactNode;
    children?: React.ReactNode;
    title?: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <div data-testid="actions">{actions}</div>
      {children}
    </div>
  ),
}));

vi.mock('../../primitives/DataTable', () => ({
  default: ({
    dataSource,
    onRowActivate,
    columns,
  }: {
    columns?: Array<{
      key?: string;
      render?: (v: unknown, row: { id: string }) => React.ReactNode;
    }>;
    dataSource?: { id: string }[];
    onRowActivate?: (row: { id: string }) => void;
  }) => {
    const actionCol = columns?.find((c) => c.key === 'actions');
    return (
      <div data-testid="holds-table">
        {(dataSource ?? []).map((row) => (
          <div data-testid={`hold-${row.id}`} key={row.id}>
            <button type="button" onClick={() => onRowActivate?.(row)}>
              open
            </button>
            {actionCol?.render?.(null, row)}
          </div>
        ))}
      </div>
    );
  },
}));

describe('LegalHoldsPage release', () => {
  beforeEach(() => {
    holdsAccess.permissions = ['platform_audit:legal_hold_manage:all'];
    holdsAccess.searchEnabled.length = 0;
    releaseLegalHold.mockReset();
    openAuditReasonModal.mockReset();
    releaseLegalHold.mockResolvedValue({ id: 'hold-9', status: 'released' });
    openAuditReasonModal.mockImplementation(
      async (opts: {
        buildPayload: (reason: string) => unknown;
        onSubmit: (payload: unknown) => Promise<void>;
      }) => {
        const payload = opts.buildPayload('case closed');
        await opts.onSubmit(payload);
      },
    );
  });

  it('opens the reason modal and releases with id + releaseReason', async () => {
    render(<LegalHoldsPage />);

    fireEvent.click(screen.getByText('audit.holds.actions.release'));

    await waitFor(() => {
      expect(openAuditReasonModal).toHaveBeenCalled();
    });
    expect(releaseLegalHold).toHaveBeenCalledWith({
      id: 'hold-9',
      releaseReason: 'case closed',
    });
  });

  it('disables AUDIT_READ user search for legal-hold-only actors on create', () => {
    render(<LegalHoldsPage />);

    fireEvent.click(screen.getByText('audit.holds.actions.create'));

    const search = screen.getByTestId('user-search');
    expect(search.getAttribute('data-enabled')).toBe('0');
    expect(holdsAccess.searchEnabled.every((e) => e === false)).toBe(true);
  });

  it('enables user search when AUDIT_READ is also granted', () => {
    holdsAccess.permissions = ['platform_audit:legal_hold_manage:all', 'platform_audit:read:all'];
    render(<LegalHoldsPage />);

    fireEvent.click(screen.getByText('audit.holds.actions.create'));

    expect(screen.getByTestId('user-search').getAttribute('data-enabled')).toBe('1');
    expect(holdsAccess.searchEnabled.some(Boolean)).toBe(true);
  });
});
