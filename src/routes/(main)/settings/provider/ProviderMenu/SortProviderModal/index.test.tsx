// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiProviderListItem } from '@/types/aiProvider';

import SortProviderModal from './index';

const mocks = vi.hoisted(() => ({
  onCancel: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  updateAiProviderSort: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; providers?: string }) =>
      options?.providers ? `${key}: ${options.count} ${options.providers}` : key,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_target, property) => String(property) }),
}));

vi.mock('@lobehub/ui', () => {
  const SortableList = ({
    items,
    renderItem,
  }: {
    items: AiProviderListItem[];
    renderItem: (item: AiProviderListItem) => ReactNode;
  }) => <div>{items.map(renderItem)}</div>;
  SortableList.Item = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  SortableList.DragHandle = () => <span>drag</span>;

  return {
    Avatar: () => <span>avatar</span>,
    Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    SortableList,
  };
});

vi.mock('@lobehub/icons', () => ({
  ProviderIcon: () => <span>provider icon</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    loading: _loading,
    onClick,
  }: {
    children?: ReactNode;
    loading?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}));

vi.mock('@/components/ImperativeModal', () => ({
  default: ({ children, open }: { children?: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ allowed: true }),
}));

vi.mock('@/store/aiInfra', () => ({
  useScopedAiInfraStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ updateAiProviderSort: mocks.updateAiProviderSort }),
}));

const providers = [
  { id: 'provider-a', name: 'Provider A', sort: 0, source: 'custom' },
  { id: 'provider-b', name: 'Provider B', sort: 1, source: 'custom' },
] as AiProviderListItem[];

describe('SortProviderModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the modal open and names providers whose order was only saved as a draft', async () => {
    mocks.updateAiProviderSort.mockRejectedValue({
      code: 'ADMIN_AI_PROVIDER_ORDER_PARTIAL_PUBLISH',
      failures: [{ providerId: 'provider-b', publishError: 'connection_test_required' }],
    });

    render(<SortProviderModal open defaultItems={providers} onCancel={mocks.onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'sortModal.update' }));

    await waitFor(() =>
      expect(mocks.toastWarning).toHaveBeenCalledWith('sortModal.partialFailure: 1 Provider B'),
    );
    expect(mocks.onCancel).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it('closes only after the complete order publishes', async () => {
    mocks.updateAiProviderSort.mockResolvedValue(undefined);

    render(<SortProviderModal open defaultItems={providers} onCancel={mocks.onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'sortModal.update' }));

    await waitFor(() => expect(mocks.onCancel).toHaveBeenCalledOnce());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('sortModal.success');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
