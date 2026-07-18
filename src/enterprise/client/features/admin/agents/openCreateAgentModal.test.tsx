// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CreateAgentContent } from './openCreateAgentModal';

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

const fillForm = () => {
  const [keyInput, reasonInput] = screen.getAllByRole('textbox');
  fireEvent.change(keyInput, { target: { value: 'research' } });
  fireEvent.change(reasonInput, { target: { value: 'create for the support team' } });
  return { keyInput, reasonInput };
};

describe('CreateAgentContent safe retry errors', () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.create.mockReset();
    mocks.success.mockReset();
  });

  it.each([
    [
      'known enterprise error',
      {
        data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
        message: 'raw permission backend detail',
      },
      'enterprise.error.PLATFORM_PERMISSION_DENIED',
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
    const { keyInput, reasonInput } = fillForm();

    fireEvent.click(screen.getByRole('button'));
    await screen.findByText(expected);

    expect(screen.queryByText(raw)).toBeNull();
    expect(keyInput).toHaveValue('research');
    expect(reasonInput).toHaveValue('create for the support team');
    expect(screen.getByRole('button')).not.toBeDisabled();

    mocks.create.mockResolvedValueOnce({ identity: { id: 'agent-2' } });
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('agent-2'));
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
