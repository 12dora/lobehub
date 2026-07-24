/**
 * Causal lifecycle tests for ReasonModalContent / createModal onOpenChange.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminReauthCancelledError } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { openReasonModal, ReasonModalContent } from './openReasonModal';

const mockClose = vi.fn();
const requestReauthMock = vi.fn();

/** Captured from real createModal props when openReasonModal runs. */
let capturedOnOpenChange: ((open: boolean) => void) | undefined;
const updateSpy = vi.fn();
/** Mirrors base-ui stack open state: closeModal commits before onOpenChange. */
let committedOpen = true;
let modalRoot: Root | null = null;
let modalHost: HTMLDivElement | null = null;

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
    createModal: (props: any) => {
      capturedOnOpenChange = props.onOpenChange;
      committedOpen = true;
      modalHost = document.createElement('div');
      document.body.appendChild(modalHost);
      modalRoot = createRoot(modalHost);
      modalRoot.render(props.content);
      return {
        close: () => {
          committedOpen = false;
          props.onOpenChange?.(false);
          mockClose();
          modalRoot?.unmount();
          modalRoot = null;
        },
        destroy: () => {
          // Distinct destroy path: onOpenChange then unmount content
          committedOpen = false;
          props.onOpenChange?.(false);
          modalRoot?.unmount();
          modalRoot = null;
        },
        setCanDismissByClickOutside: vi.fn(),
        update: (next: { open?: boolean }) => {
          updateSpy(next);
          if (next?.open === true) committedOpen = true;
          if (next?.open === false) committedOpen = false;
        },
      };
    },
    useModalContext: () => ({
      // Real base-ui: useModalContext().close() skips createModal onOpenChange.
      close: () => {
        committedOpen = false;
        mockClose();
      },
    }),
  };
});

/**
 * requestAdminReauth mock: hangs until externally resolved/rejected.
 * Does NOT self-abort to simulate the feature under test — abort comes from
 * onOpenChange / unmount / Cancel aborting the controller; after hang resolves,
 * withAdminReauthRetry checks signal.aborted and must not retry.
 */
vi.mock('@/enterprise/client/features/admin/reauth/requestAdminReauth', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Cancelled = actual.AdminReauthCancelledError as new () => Error;
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
          if (options?.signal?.aborted) throw new Cancelled();
          options?.onReauthStart?.();
          // Hang here until test resolves/rejects — do not abort inside the mock.
          await requestReauthMock({ signal: options?.signal });
          // After late reauth "success", cancel/abort must still block retry.
          if (options?.signal?.aborted) throw new Cancelled();
          return await fn();
        }
        throw error;
      }
    },
  };
});

/** Hang until caller resolves — late success after abort is delivered this way. */
const hangForLateSuccess = () => {
  let lateResolve!: () => void;
  let lateReject!: (e: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    lateResolve = resolve;
    lateReject = reject;
  });
  requestReauthMock.mockImplementation(() => promise);
  return {
    deliverLateSuccess: () => lateResolve(),
    deliverLateFailure: (e: unknown) => lateReject(e),
  };
};

/**
 * Deterministically drain the promise/microtask queue. The late-success path is pure async/await
 * (resolve → signal.aborted check → throw/retry) with no timers, so flushing microtasks lets a
 * wrongful retry increment `attempts` before we assert — no wall-clock race like a fixed sleep.
 */
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

/** Hang until signal aborts (for Cancel button path that rejects via abort). */
const hangUntilAbort = ({ signal }: { signal?: AbortSignal }) =>
  new Promise<void>((_resolve, reject) => {
    const fail = () => reject(new AdminReauthCancelledError());
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener('abort', fail, { once: true });
  });

describe('ReasonModalContent lifecycle (R4)', () => {
  beforeEach(() => {
    mockClose.mockReset();
    updateSpy.mockReset();
    requestReauthMock.mockReset();
    capturedOnOpenChange = undefined;
    committedOpen = true;
    modalRoot?.unmount();
    modalRoot = null;
    modalHost?.remove();
    modalHost = null;
    document.body.innerHTML = '';
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
          try {
            p.expiresAt.setTime(0);
            (p as { roleNames: string[] }).roleNames = ['hijacked'];
            p.roleNames.push('super_admin');
          } catch {
            // frozen
          }
          if (attempts === 1) throw new Error('ADMIN_REAUTH_REQUIRED');
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'canonical-reason' } });
    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => expect(attempts).toBe(2));
    expect(received).toEqual([
      {
        expiresAt: '2025-06-01T12:00:00.000Z',
        reason: 'canonical-reason',
        roleNames: ['user_admin', 'auditor'],
      },
      {
        expiresAt: '2025-06-01T12:00:00.000Z',
        reason: 'canonical-reason',
        roleNames: ['user_admin', 'auditor'],
      },
    ]);
  });

  it('createModal onOpenChange(false) during reauthing aborts; late success yields zero retry', async () => {
    let attempts = 0;
    const { deliverLateSuccess } = hangForLateSuccess();

    openReasonModal({
      title: 'T',
      targetLabel: 'u',
      submitLabel: 'Confirm',
      buildPayload: (r) => ({ reason: r }),
      onSubmit: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('ADMIN_REAUTH_REQUIRED');
      },
    });

    await waitFor(() => expect(screen.getByLabelText('reason')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Confirm'));

    // Enter actual reauthing with an active hanging controller
    await waitFor(() => expect(screen.getByText('users.reauth.cancel')).toBeTruthy());
    expect(attempts).toBe(1);
    expect(typeof capturedOnOpenChange).toBe('function');
    expect(requestReauthMock).toHaveBeenCalledTimes(1);

    // Real Escape path: captured createModal onOpenChange(false) — mock does not self-abort
    capturedOnOpenChange!(false);

    // Deliver late reauth success after abort; retry must not run
    deliverLateSuccess();

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/reauthCancelled/);
    });
    expect(attempts).toBe(1);
  });

  it('RTL unmount during reauthing aborts; late success yields zero retry', async () => {
    let attempts = 0;
    const phases: string[] = [];
    const { deliverLateSuccess } = hangForLateSuccess();

    const { unmount } = render(
      <ReasonModalContent
        buildPayload={(r) => ({ reason: r })}
        submitLabel="Confirm"
        targetLabel="u"
        title="T"
        onPhaseChange={(p) => phases.push(p)}
        onSubmit={async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('ADMIN_REAUTH_REQUIRED');
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => expect(phases).toContain('reauthing'));
    expect(attempts).toBe(1);
    expect(requestReauthMock).toHaveBeenCalledTimes(1);

    // Unmount cleanup aborts active controller + clears canonical
    unmount();

    // Late success after unmount must not trigger retry (mounted guards + abort)
    deliverLateSuccess();
    await flushMicrotasks();
    expect(attempts).toBe(1);
  });

  it('ModalInstance.destroy during reauthing aborts with zero retry on late success', async () => {
    let attempts = 0;
    const { deliverLateSuccess } = hangForLateSuccess();

    const instance = openReasonModal({
      title: 'T',
      targetLabel: 'u',
      submitLabel: 'Confirm',
      buildPayload: (r) => ({ reason: r }),
      onSubmit: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('ADMIN_REAUTH_REQUIRED');
      },
    });

    await waitFor(() => expect(screen.getByLabelText('reason')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(screen.getByText('users.reauth.cancel')).toBeTruthy());
    expect(attempts).toBe(1);

    // destroy: onOpenChange(false) + unmount — distinct from bare Escape if both fire
    instance.destroy();
    deliverLateSuccess();
    await flushMicrotasks();
    expect(attempts).toBe(1);
  });

  it('reauth Cancel button aborts without second submit', async () => {
    let attempts = 0;
    // Cancel aborts the controller; hangUntilAbort rejects so the flow settles
    requestReauthMock.mockImplementation(hangUntilAbort);

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

  it('Escape during mutating re-opens the modal so the in-flight mutation keeps its UI', async () => {
    updateSpy.mockReset();
    let resolveSubmit!: () => void;
    const phases: string[] = [];

    openReasonModal({
      title: 'T',
      targetLabel: 'u',
      submitLabel: 'Confirm',
      buildPayload: (r) => ({ reason: r }),
      onPhaseChange: (p) => phases.push(p),
      onSubmit: () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    });

    await waitFor(() => expect(screen.getByLabelText('reason')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('reason'), { target: { value: 'delete-me' } });
    fireEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(phases).toContain('mutating'));

    // base-ui commits Escape close before onOpenChange — veto while mutating.
    committedOpen = false;
    capturedOnOpenChange!(false);

    expect(updateSpy).toHaveBeenCalledWith({ open: true });
    expect(committedOpen).toBe(true);

    resolveSubmit();
    await waitFor(() => expect(mockClose).toHaveBeenCalled());
  });
});
