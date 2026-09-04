// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProvisionDefaultInbox } from './useProvisionDefaultInbox';

const mocks = vi.hoisted(() => ({
  provisionDefaultInbox: vi.fn(),
  refresh: vi.fn(),
  runAdminMutation: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('i18next', () => ({ default: { language: 'en-US', resolvedLanguage: 'zh-CN' } }));
vi.mock('@lobehub/ui/base-ui', () => ({
  toast: {
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    warning: (...args: unknown[]) => mocks.toastWarning(...args),
  },
}));
vi.mock('@/enterprise/client/features/admin/primitives/runAdminMutation', () => ({
  runAdminMutation: (...args: unknown[]) => mocks.runAdminMutation(...args),
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({ adminAgentsService: {} }));

const client = {
  provisionDefaultInbox: (...args: unknown[]) => mocks.provisionDefaultInbox(...args),
} as never;

const renderProvision = (autoProvision: boolean) =>
  renderHook(
    ({ autoProvision }: { autoProvision: boolean }) =>
      useProvisionDefaultInbox({
        authMethod: 'better-auth',
        autoProvision,
        client,
        refresh: mocks.refresh,
      }),
    { initialProps: { autoProvision } },
  );

describe('useProvisionDefaultInbox', () => {
  beforeEach(() => {
    mocks.provisionDefaultInbox.mockReset().mockResolvedValue({ identity: { id: 'agent-new' } });
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    mocks.toastSuccess.mockReset();
    mocks.toastWarning.mockReset();
    // Mirrors the real primitive: the caller's own error surface replaces the default toast.
    mocks.runAdminMutation
      .mockReset()
      .mockImplementation(
        async ({
          onError,
          run,
        }: {
          onError?: (error: unknown) => Promise<void> | void;
          run: () => Promise<void>;
        }) => {
          try {
            await run();
            return true;
          } catch (error) {
            await onError?.(error);
            return false;
          }
        },
      );
  });

  it('provisions on mount in the admin’s own UI language, then invalidates both surfaces', async () => {
    const { result } = renderProvision(true);

    await waitFor(() => expect(mocks.provisionDefaultInbox).toHaveBeenCalledOnce());
    expect(mocks.provisionDefaultInbox).toHaveBeenCalledWith({ locale: 'zh-CN' });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('agentCatalog.defaultAgent.provision.success');
    expect(result.current.failed).toBe(false);
    expect(result.current.provisioning).toBe(false);
  });

  it('writes nothing until the caller says the default is really missing', async () => {
    const { rerender } = renderProvision(false);
    expect(mocks.provisionDefaultInbox).not.toHaveBeenCalled();

    rerender({ autoProvision: true });
    await waitFor(() => expect(mocks.provisionDefaultInbox).toHaveBeenCalledOnce());
  });

  it('attempts once per mount, however often the caller re-arms it', async () => {
    const { rerender } = renderProvision(true);
    await waitFor(() => expect(mocks.provisionDefaultInbox).toHaveBeenCalledOnce());

    // The pointer read still says "no default" while the refresh above is in flight, so the flag
    // going false → true again must not turn into an unbounded write loop.
    rerender({ autoProvision: false });
    rerender({ autoProvision: true });
    expect(mocks.provisionDefaultInbox).toHaveBeenCalledOnce();
  });

  it('reports a failure to its caller instead of toasting an unprompted error', async () => {
    mocks.provisionDefaultInbox.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderProvision(true);

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    // The explicit retry is the only re-attempt, and it clears the failure it reported.
    await act(() => result.current.provision());
    expect(mocks.provisionDefaultInbox).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.failed).toBe(false));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('agentCatalog.defaultAgent.provision.success');
  });

  it('still confirms the write when the follow-up revalidation fails', async () => {
    mocks.refresh.mockRejectedValueOnce(new Error('offline'));
    renderProvision(true);

    await waitFor(() =>
      expect(mocks.toastWarning).toHaveBeenCalledWith('agentCatalog.recovery.refreshFailed'),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('agentCatalog.defaultAgent.provision.success');
  });
});
