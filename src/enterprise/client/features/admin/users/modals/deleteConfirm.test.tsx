/**
 * Hard-delete type-to-confirm: production validator + ReasonModalContent wiring.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HARD_DELETE_TYPE_CONFIRM_MISMATCH, validateHardDeleteConfirm } from './deleteConfirm';
import { ReasonModalContent } from './openReasonModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: { colorError: 'red', fontSizeLG: '16px' },
}));

vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Text: ({ children, ...rest }: { children?: React.ReactNode }) =>
      React.createElement('span', rest, children),
    TextArea: ({
      value,
      onChange,
      disabled,
    }: {
      disabled?: boolean;
      onChange?: (e: { target: { value: string } }) => void;
      value?: string;
    }) =>
      React.createElement('textarea', {
        'aria-label': 'reason',
        disabled,
        value,
        onChange,
      }),
  };
});

vi.mock('@lobehub/ui/base-ui', async () => {
  const React = await import('react');
  return {
    Button: ({
      children,
      onClick,
      disabled,
      loading,
      ...rest
    }: {
      children?: React.ReactNode;
      disabled?: boolean;
      loading?: boolean;
      onClick?: () => void;
    }) =>
      React.createElement(
        'button',
        { type: 'button', onClick, disabled: disabled || loading, ...rest },
        children,
      ),
    useModalContext: () => ({ close: vi.fn() }),
  };
});

vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withAdminReauthRetry: async (fn: () => Promise<unknown>) => fn(),
  };
});

describe('validateHardDeleteConfirm (production)', () => {
  const target = 'bob@example.com';

  it('rejects empty, whitespace, and mismatched labels', () => {
    expect(validateHardDeleteConfirm('', target)).toBe(HARD_DELETE_TYPE_CONFIRM_MISMATCH);
    expect(validateHardDeleteConfirm('  ', target)).toBe(HARD_DELETE_TYPE_CONFIRM_MISMATCH);
    expect(validateHardDeleteConfirm('wrong', target)).toBe(HARD_DELETE_TYPE_CONFIRM_MISMATCH);
    expect(validateHardDeleteConfirm(`${target}x`, target)).toBe(HARD_DELETE_TYPE_CONFIRM_MISMATCH);
  });

  it('accepts an exact match (trim only on the typed side)', () => {
    expect(validateHardDeleteConfirm(target, target)).toBeNull();
    expect(validateHardDeleteConfirm(`  ${target}  `, target)).toBeNull();
  });
});

describe('hard delete type-to-confirm eligibility via production validator', () => {
  const target = 'bob@example.com';
  let confirmText = '';

  beforeEach(() => {
    confirmText = '';
  });

  const renderDeleteModal = (onSubmit = vi.fn()) =>
    render(
      <ReasonModalContent
        hideReason
        autoReason="admin.users.delete"
        buildPayload={(reason) => ({ reason, userId: 'u1' })}
        submitLabel="Delete"
        targetLabel={target}
        title="Delete user"
        validateExtra={() => validateHardDeleteConfirm(confirmText, target)}
        extra={({ reportExtraChange }) => (
          <input
            aria-label="users.modals.delete.typeConfirmLabel"
            onChange={(e) => {
              confirmText = e.target.value;
              reportExtraChange();
            }}
          />
        )}
        onSubmit={onSubmit}
      />,
    );

  it('keeps submit disabled when confirmation text mismatches', () => {
    renderDeleteModal();
    const submit = screen.getByText('Delete');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('users.modals.delete.typeConfirmLabel'), {
      target: { value: 'wrong' },
    });
    expect(submit).toBeDisabled();
  });

  it('enables submit when confirmation text matches exactly, then accepts the click', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderDeleteModal(onSubmit);

    const submit = screen.getByText('Delete');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('users.modals.delete.typeConfirmLabel'), {
      target: { value: target },
    });
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({ reason: 'admin.users.delete', userId: 'u1' });
  });
});
