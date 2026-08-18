import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { securityStyles } from '../styles';
import BackupCodes from './BackupCodes';

vi.mock('@lobehub/ui', () => ({
  copyToClipboard: vi.fn(),
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
});

describe('BackupCodes', () => {
  it('renders every code', () => {
    render(<BackupCodes codes={['aaa-111', 'bbb-222']} />);

    expect(screen.getByText('aaa-111')).toBeInTheDocument();
    expect(screen.getByText('bbb-222')).toBeInTheDocument();
  });

  it('keeps the caller action in the same row as copy and download', () => {
    render(<BackupCodes actions={<button type="button">done</button>} codes={['aaa-111']} />);

    const copy = screen.getByRole('button', {
      name: 'profile.security.twoFactor.backupCodes.copy',
    });
    const done = screen.getByRole('button', { name: 'done' });

    // Copy/Download sit in their own group; the caller's action is that group's sibling,
    // so the screen ends with one action row rather than two stacked ones.
    expect(done.parentElement).toBe(copy.parentElement?.parentElement);
  });

  it('uses the wrapping footer row so narrow modals cannot clip an action', () => {
    render(<BackupCodes actions={<button type="button">done</button>} codes={['aaa-111']} />);

    const row = screen.getByRole('button', { name: 'done' }).parentElement;

    // The row is ~262px wide on a 320px viewport and the labels are translated; the shared
    // class is the one that carries `flex-wrap: wrap`.
    expect(row).toHaveClass(securityStyles.footerSpread);
  });
});
