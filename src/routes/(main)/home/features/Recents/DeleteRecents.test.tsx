/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeleteRecents from './DeleteRecents';

const mocks = vi.hoisted(() => ({
  confirmModal: vi.fn(),
  removeTopicsByTimeRange: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

interface MenuItem {
  danger?: boolean;
  disabled?: boolean;
  key: string;
  label: string;
  onClick: () => void;
}

vi.mock('@lobehub/ui', () => ({
  ActionIcon: ({ title }: { title?: string }) => <span data-testid="trash-trigger">{title}</span>,
  DropdownMenu: ({ children, items }: { children: React.ReactNode; items: MenuItem[] }) => (
    <div>
      {children}
      {items.map((item) => (
        <button
          data-danger={String(!!item.danger)}
          data-testid={`range-${item.key}`}
          key={item.key}
          onClick={item.onClick}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  confirmModal: mocks.confirmModal,
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}_${options.count}`,
  }),
}));

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({ removeTopicsByTimeRange: mocks.removeTopicsByTimeRange }),
}));

const confirmProps = () => mocks.confirmModal.mock.calls.at(-1)?.[0];

describe('DeleteRecents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeTopicsByTimeRange.mockResolvedValue(['tpc_1', 'tpc_2']);
  });

  it('offers the four deletion ranges', () => {
    render(<DeleteRecents />);

    expect(screen.getByTestId('range-24h').textContent).toBe('recentsDelete.range.24h');
    expect(screen.getByTestId('range-7d').textContent).toBe('recentsDelete.range.7d');
    expect(screen.getByTestId('range-30d').textContent).toBe('recentsDelete.range.30d');
    expect(screen.getByTestId('range-all').textContent).toBe('recentsDelete.range.all');
  });

  it('marks only the irreversible "all" entry as dangerous', () => {
    render(<DeleteRecents />);

    expect(screen.getByTestId('range-24h').dataset.danger).toBe('false');
    expect(screen.getByTestId('range-all').dataset.danger).toBe('true');
  });

  it('asks for confirmation naming the chosen range before deleting anything', () => {
    render(<DeleteRecents />);

    fireEvent.click(screen.getByTestId('range-7d'));

    expect(mocks.removeTopicsByTimeRange).not.toHaveBeenCalled();
    expect(confirmProps().content).toBe('recentsDelete.confirm.desc.7d');
    expect(confirmProps().title).toBe('recentsDelete.confirm.title');
    expect(confirmProps().okButtonProps).toEqual({ danger: true });
  });

  it('deletes the chosen range once confirmed and reports how many went away', async () => {
    mocks.confirmModal.mockImplementation(async ({ onOk }: { onOk: () => Promise<void> }) => {
      await onOk();
    });
    render(<DeleteRecents />);

    fireEvent.click(screen.getByTestId('range-30d'));

    await waitFor(() => {
      expect(mocks.removeTopicsByTimeRange).toHaveBeenCalledWith('30d');
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('recentsDelete.success_2');
  });

  it('surfaces a failed deletion instead of claiming success', async () => {
    mocks.removeTopicsByTimeRange.mockRejectedValue(new Error('boom'));
    mocks.confirmModal.mockImplementation(async ({ onOk }: { onOk: () => Promise<void> }) => {
      await onOk();
    });
    render(<DeleteRecents />);

    fireEvent.click(screen.getByTestId('range-all'));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('recentsDelete.error');
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
