// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CREATE_AGENT_REASON, CreateAgentContent } from './openCreateAgentModal';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  create: vi.fn(),
  success: vi.fn(),
}));

vi.mock('i18next', () => ({ t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: { create: mocks.create },
}));
vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  createModal: vi.fn(),
  toast: { success: mocks.success },
  useModalContext: () => ({ close: mocks.close }),
}));

const fillName = (value = 'research') => {
  const nameInput = screen.getByRole('textbox');
  fireEvent.change(nameInput, { target: { value } });
  return nameInput;
};

describe('CreateAgentContent', () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.create.mockReset();
    mocks.success.mockReset();
  });

  it('does not render a user-facing reason field', () => {
    render(<CreateAgentContent onCreated={vi.fn()} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByText('agentCatalog.create.reason')).toBeNull();
    expect(screen.getByText('agentCatalog.create.key')).toBeTruthy();
  });

  it('submits the fixed audit reason constant with agentKey wire contract', async () => {
    const onCreated = vi.fn().mockResolvedValue(undefined);
    mocks.create.mockResolvedValueOnce({ identity: { id: 'agent-1' } });
    render(<CreateAgentContent onCreated={onCreated} />);
    fillName('  research-assistant  ');

    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        agentKey: 'research-assistant',
        isDefault: false,
        reason: CREATE_AGENT_REASON,
        systemKey: null,
      }),
    );
    expect(CREATE_AGENT_REASON).toBe('Platform assistant created from admin console');
    expect(onCreated).toHaveBeenCalledWith('agent-1');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'known enterprise error',
      {
        data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
        message: 'raw permission backend detail',
      },
      'agentCatalog.errors.generic',
      'raw permission backend detail',
    ],
    [
      'unknown error',
      new Error('SQLSTATE 08006 password=never-render'),
      'agentCatalog.errors.generic',
      'SQLSTATE 08006 password=never-render',
    ],
  ])('preserves input and supports retry after a %s', async (_label, cause, expected, raw) => {
    const onCreated = vi.fn().mockResolvedValue(undefined);
    mocks.create.mockRejectedValueOnce(cause);
    render(<CreateAgentContent onCreated={onCreated} />);
    const nameInput = fillName();

    fireEvent.click(screen.getByRole('button'));
    await screen.findByText(expected);

    expect(screen.queryByText(raw)).toBeNull();
    expect(nameInput).toHaveValue('research');
    expect(screen.getByRole('button')).not.toBeDisabled();
    // Still a single name field after error (no reason field reintroduced).
    expect(screen.getAllByRole('textbox')).toHaveLength(1);

    mocks.create.mockResolvedValueOnce({ identity: { id: 'agent-2' } });
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('agent-2'));
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentKey: 'research',
        reason: CREATE_AGENT_REASON,
      }),
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
