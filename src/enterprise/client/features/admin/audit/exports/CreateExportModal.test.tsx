/**
 * Include-bodies Switch stays disabled when policy does not allow content.
 * @vitest-environment happy-dom
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import CreateExportModal from './CreateExportModal';

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
  Input: ({
    onChange,
    value,
  }: {
    onChange?: (e: { target: { value: string } }) => void;
    value?: string;
  }) => <input value={value} onChange={onChange} />,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Modal: ({
    children,
    footer,
    open,
    title,
  }: {
    children?: React.ReactNode;
    footer?: React.ReactNode;
    open?: boolean;
    title?: React.ReactNode;
  }) =>
    open ? (
      <div>
        <h1>{title}</h1>
        {children}
        <div>{footer}</div>
      </div>
    ) : null,
  Switch: ({
    checked,
    disabled,
    onChange,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onChange?: (v: boolean) => void;
  }) => (
    <input
      checked={Boolean(checked)}
      disabled={disabled}
      role="switch"
      type="checkbox"
      onChange={(e) => onChange?.(e.target.checked)}
    />
  ),
}));

vi.mock('antd', () => ({
  DatePicker: {
    RangePicker: () => <div data-testid="range-picker" />,
  },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: 'better-auth',
    permissions: ['platform_audit:read:all'],
    roles: [],
  }),
}));

vi.mock('../hooks/useAdminAudit', () => ({
  useFetchAuditPolicy: () => ({
    data: {
      contentAccessMode: 'metadata_only',
      messageBodyInExport: true,
    },
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  }),
}));

vi.mock('../shared/AuditUserSearchSelect', () => ({
  default: () => <div data-testid="user-search" />,
}));

vi.mock('../shared/openAuditReasonModal', () => ({
  openAuditReasonModal: vi.fn(),
}));

describe('CreateExportModal', () => {
  it('disables the include-bodies Switch when policy is not content_allowed', async () => {
    render(
      <CreateExportModal
        open
        searchParams={new URLSearchParams('kind=conversations&userId=u1')}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeDisabled();
    });
  });
});
