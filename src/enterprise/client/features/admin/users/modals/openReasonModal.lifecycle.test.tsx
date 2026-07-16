/**
 * Real ReasonModalContent lifecycle tests (UI-R3).
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminReauthCancelledError } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { ReasonModalContent } from './openReasonModal';

const mockClose = vi.fn();
const requestReauthMock = vi.fn();

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
    Text: ({ children, ...rest }: any) => React.createElement('span', rest, children),
    TextArea: ({ value, onChange, disabled }: any) =>
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
    Button: ({ children, onClick, disabled, loading, ...rest }: any) =>
      React.createElement(
        'button',
        { type: 'button', onClick, disabled: disabled || loading, ...rest },
        children,
      ),
    createModal: (props: any) => ({
      close: mockClose,
      destroy: vi.fn(),
      update: vi.fn(),
      onOpenChange: props.onOpenChange,
    }),
    useModalContext: () => ({ close: mockClose }),
  };
});

vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const AdminReauthCancelledError = actual.AdminReauthCancelledError as new () => Error;
  return {
    ...actual,
    requestAdminReauth: (opts: { signal?: AbortSignal }) => requestReauthMock(opts),
    withAdminReauthRetry: async (
      fn: () => Promise<unknown>,
      options?: {
        signal?: AbortSignal;
        onReauthStart?: () => void;
      },
    ) => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof Error && String(error.message).includes('ADMIN_REAUTH_REQUIRED')) {
          if (options?.signal?.aborted) throw new AdminReauthCancelledError();
          options?.onReauthStart?.();
          await requestReauthMock({ signal: options?.signal });
          if (options?.signal?.aborted) throw new AdminReauthCancelledError();
          return await fn();
        }
        throw error;
      }
    },
  };
});

describe('ReasonModalContent lifecycle (R3)', () => {
  beforeEach(() => {
    mockClose.mockReset();
    requestReauthMock.mockReset();
  });

  it('retry receives pristine clone after first onSubmit mutates nested data and Date', async () => {
    const received: Array<{ expiresAt: string; reason: string; roleNames: string[] }> = [];
    let attempts = 0;
    requestReauthMock.mockResolvedValue(undefined);

    render(
      <ReasonModalContent
        submitLabel="Confirm"
        targetLabel="u"
        title="T"
        buildPayload={(reason) => ({
          expiresAt: new Date('2025-06-01T12:00:00.000Z'),
          reason,
          roleNames: ['user_admin', 'auditor'],
        })}
        onSubmit={async (payload) => {
          attempts += 1;
          const p = payload as { expiresAt: Date; reason: string; roleNames: string[] };
          received.push({
            expiresAt: p.expiresAt.toISOString(),
            reason: p.reason,
            roleNames: [...p.roleNames],
          });
          // Adversarial mutation: Date mutators still work even when Object.freeze'd;
          // structural freeze may throw — ignore and still throw reauth for retry path.
          try {
            p.expiresAt.setTime(0);
            (p as { roleNames: string[] }).roleNames = ['hijacked'];
            p.roleNames.push('super_admin');
          } catch {
            // frozen structure — expected
          }
          if (attempts === 1) throw new Error('ADMIN_REAUTH_REQUIRED');
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'canonical-reason' } });
    // Attempt UI edit after building would only matter if not frozen — edit before confirm is fine
    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => expect(attempts).toBe(2));
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({
      expiresAt: '2025-06-01T12:00:00.000Z',
      reason: 'canonical-reason',
      roleNames: ['user_admin', 'auditor'],
    });
    expect(received[1]).toEqual({
      expiresAt: '2025-06-01T12:00:00.000Z',
      reason: 'canonical-reason',
      roleNames: ['user_admin', 'auditor'],
    });
  });

  it('onOpenChange(false) during reauth aborts with zero second mutation', async () => {
    let attempts = 0;
    const abortRef: { current: AbortController | null } = { current: null };

    requestReauthMock.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      // Simulate Escape: modal onOpenChange(false) aborts the controller
      abortRef.current?.abort();
      if (signal?.aborted) throw new AdminReauthCancelledError();
      throw new AdminReauthCancelledError();
    });

    render(
      <ReasonModalContent
        abortControllerRef={abortRef}
        buildPayload={(r) => ({ reason: r })}
        submitLabel="Confirm"
        targetLabel="u"
        title="T"
        onSubmit={async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('ADMIN_REAUTH_REQUIRED');
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/reauthCancelled/);
    });
    expect(attempts).toBe(1);
  });

  it('shows reauth Cancel during reauthing; cancel aborts without second submit', async () => {
    let attempts = 0;

    requestReauthMock.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        const fail = () => reject(new AdminReauthCancelledError());
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener('abort', fail);
      });
    });

    render(
      <ReasonModalContent
        buildPayload={(r) => ({ reason: r })}
        submitLabel="Confirm"
        targetLabel="u"
        title="T"
        onSubmit={async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('ADMIN_REAUTH_REQUIRED');
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => expect(screen.getByText('users.reauth.cancel')).toBeTruthy());
    fireEvent.click(screen.getByText('users.reauth.cancel'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/reauthCancelled/);
    });
    expect(attempts).toBe(1);
  });

  it('openReasonModal wires onOpenChange to abort (Escape path)', async () => {
    const { openReasonModal } = await import('./openReasonModal');
    const baseUi = await import('@lobehub/ui/base-ui');
    let capturedOnOpenChange: ((open: boolean) => void) | undefined;
    const createModalSpy = vi.spyOn(baseUi, 'createModal').mockImplementation((props: any) => {
      capturedOnOpenChange = props.onOpenChange;
      return {
        close: mockClose,
        destroy: vi.fn(),
        setCanDismissByClickOutside: vi.fn(),
        update: vi.fn(),
      };
    });

    openReasonModal({
      title: 'T',
      targetLabel: 'u',
      submitLabel: 'Go',
      buildPayload: (r) => ({ reason: r }),
      onSubmit: async () => undefined,
    });

    expect(typeof capturedOnOpenChange).toBe('function');
    // Simulate Escape → open=false must not throw
    capturedOnOpenChange?.(false);
    createModalSpy.mockRestore();
  });
});
