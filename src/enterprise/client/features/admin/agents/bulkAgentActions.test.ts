import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AdminReauthCancelledError,
  withAdminReauthRetry,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { openBulkArchiveAgentsModal, openBulkDeleteAgentsModal } from './bulkAgentActions';
import type { AdminAgentListItem } from './types';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  closeModal: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  openReasonModal: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: {
    error: vi.fn(),
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    warning: (...args: unknown[]) => mocks.toastWarning(...args),
  },
}));
vi.mock('@/enterprise/client/features/admin/users/modals/openReasonModal', () => ({
  openReasonModal: (...args: unknown[]) => mocks.openReasonModal(...args),
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: {
    archive: (...args: unknown[]) => mocks.archive(...args),
    delete: (...args: unknown[]) => mocks.delete(...args),
    get: (...args: unknown[]) => mocks.get(...args),
  },
}));

/** Keys pass through so assertions read as the copy contract, not the translation. */
const t = ((key: string) => key) as unknown as TFunction<'admin'>;

const row = (id: string, over: Partial<AdminAgentListItem['identity']> = {}): AdminAgentListItem =>
  ({
    assignmentCount: 0,
    displayName: id,
    identity: { agentKey: id, id, isDefault: false, status: 'published', systemKey: null, ...over },
    publishedVersion: null,
  }) as never;

const snapshot = (id: string, revision: number) => ({
  draftToken: `${id}-token`,
  identity: { agentKey: id, id, isDefault: false, revision, status: 'published', systemKey: null },
});

interface ReasonModalParams {
  autoReason?: string;
  buildPayload: (reason: string) => unknown;
  onPhaseChange?: (phase: 'idle' | 'mutating' | 'reauthing') => void;
  onSubmit: (payload: unknown) => Promise<void>;
}

/** Let the settle path (toast + onDone + close) run before the assertions read it. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Run the confirmation the way the reason modal does: one submit wrapped in the shared
 * reauth retry, with the same phase transitions `useReauthMutation` emits.
 */
const submitLastModal = async (options: { requestReauth?: () => Promise<void> } = {}) => {
  const params = mocks.openReasonModal.mock.calls.at(-1)![0] as ReasonModalParams;
  const payload = params.buildPayload(params.autoReason ?? '');
  let error: unknown;

  try {
    await withAdminReauthRetry(
      async () => {
        params.onPhaseChange?.('mutating');
        await params.onSubmit(payload);
      },
      {
        requestReauth: options.requestReauth ?? (() => Promise.resolve()),
        onReauthStart: () => params.onPhaseChange?.('reauthing'),
      },
    );
  } catch (caught) {
    error = caught;
    params.onPhaseChange?.('idle');
  }

  await flush();
  return { error, params };
};

/** What the server sends when the write needs a fresh interactive login. */
const reauthRequired = () => new Error('ADMIN_REAUTH_REQUIRED');

describe('bulk platform-assistant actions', () => {
  beforeEach(() => {
    mocks.archive.mockReset().mockResolvedValue({});
    mocks.delete.mockReset().mockResolvedValue({ deleted: true });
    mocks.get.mockReset().mockImplementation(({ id }: { id: string }) => snapshot(id, 7));
    mocks.closeModal.mockReset();
    mocks.openReasonModal.mockReset().mockReturnValue({ close: mocks.closeModal });
    mocks.toastSuccess.mockReset();
    mocks.toastWarning.mockReset();
  });

  describe('archive', () => {
    const selection = [
      row('a'),
      row('b'),
      row('archived', { status: 'archived' }),
      row('default', { isDefault: true }),
    ];

    it('confirms once for the whole batch and reports what will be skipped', () => {
      openBulkArchiveAgentsModal({ authMethod: 'better-auth', rows: selection, t });

      expect(mocks.openReasonModal).toHaveBeenCalledOnce();
      expect(mocks.openReasonModal.mock.calls[0]![0]).toMatchObject({
        autoReason: 'admin.agents.archive',
        danger: true,
        hideReason: true,
        impact: 'agentCatalog.bulk.skipped',
        title: 'agentCatalog.bulk.archive.title',
      });
    });

    it('reads authoritative CAS per eligible id and skips archived / default rows', async () => {
      openBulkArchiveAgentsModal({ rows: selection, t });
      await submitLastModal();

      // List rows carry no draftToken — every write is authored from a fresh snapshot.
      expect(mocks.get.mock.calls.map(([input]) => input)).toEqual([{ id: 'a' }, { id: 'b' }]);
      expect(mocks.archive).toHaveBeenCalledTimes(2);
      expect(mocks.archive.mock.calls[0]![0]).toEqual({
        agentId: 'a',
        expectedDraftToken: 'a-token',
        expectedRevision: 7,
        reason: 'admin.agents.archive',
        // Non-default rows only, so a successor is never required.
        replacementAgentId: null,
      });
    });

    it('summarises done and skipped in one toast', async () => {
      openBulkArchiveAgentsModal({ rows: selection, t });
      await submitLastModal();

      expect(mocks.toastSuccess).toHaveBeenCalledOnce();
      expect(String(mocks.toastSuccess.mock.calls[0]![0])).toBe(
        'agentCatalog.toast.bulkDone · agentCatalog.toast.bulkSkipped',
      );
      expect(mocks.toastWarning).not.toHaveBeenCalled();
    });

    it('keeps going after one failure and reports it in the summary', async () => {
      mocks.archive.mockRejectedValueOnce(new Error('conflict'));
      const onDone = vi.fn();
      openBulkArchiveAgentsModal({ onDone, rows: [row('a'), row('b')], t });
      await submitLastModal();

      expect(mocks.archive).toHaveBeenCalledTimes(2);
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(String(mocks.toastWarning.mock.calls[0]![0])).toContain(
        'agentCatalog.toast.bulkSummary',
      );
      // The batch owns the error surface; the list still revalidates.
      expect(onDone).toHaveBeenCalledOnce();
    });

    it('does not open a confirmation when nothing in the selection is archivable', () => {
      openBulkArchiveAgentsModal({ rows: [row('archived', { status: 'archived' })], t });
      expect(mocks.openReasonModal).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    const selection = [
      row('a'),
      row('system', { systemKey: 'default-inbox' }),
      row('default', { isDefault: true }),
    ];

    it('uses the same fixed auto-reason and confirm-only shape as the row action', () => {
      openBulkDeleteAgentsModal({ rows: selection, t });
      expect(mocks.openReasonModal.mock.calls[0]![0]).toMatchObject({
        autoReason: 'Platform assistant hard-deleted from admin console',
        danger: true,
        hideReason: true,
        title: 'agentCatalog.bulk.delete.title',
      });
    });

    it('skips system and default assistants the server would refuse anyway', async () => {
      openBulkDeleteAgentsModal({ rows: selection, t });
      await submitLastModal();

      expect(mocks.get.mock.calls.map(([input]) => input)).toEqual([{ id: 'a' }]);
      expect(mocks.delete).toHaveBeenCalledOnce();
      expect(mocks.delete.mock.calls[0]![0]).toEqual({
        agentId: 'a',
        expectedDraftToken: 'a-token',
        expectedRevision: 7,
        reason: 'Platform assistant hard-deleted from admin console',
      });
      expect(String(mocks.toastSuccess.mock.calls[0]![0])).toContain(
        'agentCatalog.toast.bulkSkipped',
      );
    });

    it('reports a preflight failure as a failed row instead of writing on unknown CAS', async () => {
      mocks.get.mockRejectedValueOnce(new Error('offline'));
      openBulkDeleteAgentsModal({ rows: [row('a')], t });
      await submitLastModal();

      expect(mocks.delete).not.toHaveBeenCalled();
      expect(mocks.toastWarning).toHaveBeenCalledOnce();
    });

    it('does not open a confirmation when only default / system rows are selected', () => {
      openBulkDeleteAgentsModal({ rows: selection.slice(1), t });
      expect(mocks.openReasonModal).not.toHaveBeenCalled();
    });
  });

  describe('re-authentication', () => {
    it('prompts once for the whole batch and never replays a committed target', async () => {
      // `b` demands a fresh login; `a` is already committed when that happens.
      mocks.archive.mockImplementationOnce(() => Promise.resolve({}));
      mocks.archive.mockImplementationOnce(() => Promise.reject(reauthRequired()));
      const requestReauth = vi.fn().mockResolvedValue(undefined);
      const onDone = vi.fn();

      openBulkArchiveAgentsModal({
        authMethod: 'better-auth',
        onDone,
        rows: [row('a'), row('b'), row('c')],
        t,
      });
      const { error } = await submitLastModal({ requestReauth });

      expect(error).toBeUndefined();
      // One prompt covers the rest of the batch.
      expect(requestReauth).toHaveBeenCalledOnce();
      // `a` committed before the prompt and is not written twice; `b` retries, then `c` runs.
      expect(mocks.archive.mock.calls.map(([input]) => input.agentId)).toEqual([
        'a',
        'b',
        'b',
        'c',
      ]);
      expect(mocks.get.mock.calls.map(([input]) => input.id)).toEqual(['a', 'b', 'b', 'c']);
      expect(String(mocks.toastSuccess.mock.calls[0]![0])).toBe('agentCatalog.toast.bulkDone');
      expect(onDone).toHaveBeenCalledOnce();
    });

    it('stops the batch when the prompt is cancelled and reports it as cancelled', async () => {
      mocks.archive.mockImplementationOnce(() => Promise.reject(reauthRequired()));
      const requestReauth = vi.fn().mockRejectedValue(new AdminReauthCancelledError());
      const onDone = vi.fn();

      openBulkArchiveAgentsModal({ onDone, rows: [row('a'), row('b'), row('c')], t });
      const { error } = await submitLastModal({ requestReauth });

      expect(error).toBeInstanceOf(AdminReauthCancelledError);
      // No second prompt, and nothing is read or written past the cancelled target.
      expect(requestReauth).toHaveBeenCalledOnce();
      expect(mocks.get.mock.calls.map(([input]) => input.id)).toEqual(['a']);
      expect(mocks.archive).toHaveBeenCalledOnce();
      // Cancellation is not a row failure: it leads the summary and closes the modal out.
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(String(mocks.toastWarning.mock.calls[0]![0])).toBe('agentCatalog.toast.bulkCancelled');
      expect(mocks.closeModal).toHaveBeenCalledOnce();
      expect(onDone).toHaveBeenCalledOnce();
    });

    it('closes on cancellation before the refresh settles and ignores a resubmission', async () => {
      mocks.archive.mockImplementationOnce(() => Promise.reject(reauthRequired()));
      const requestReauth = vi.fn().mockRejectedValue(new AdminReauthCancelledError());
      // The list revalidation is still in flight while the operator can still click submit.
      let releaseRefresh = () => {};
      const onDone = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          }),
      );

      openBulkArchiveAgentsModal({ onDone, rows: [row('a'), row('b'), row('c')], t });
      const { params } = await submitLastModal({ requestReauth });

      // Closed from the phase change, not after the pending refresh.
      expect(mocks.closeModal).toHaveBeenCalledOnce();
      expect(onDone).toHaveBeenCalledOnce();
      const reads = mocks.get.mock.calls.length;
      const writes = mocks.archive.mock.calls.length;

      // A second click on the stale submit must not touch the targets left pending.
      await params.onSubmit(params.buildPayload(params.autoReason ?? ''));
      await flush();

      expect(mocks.get).toHaveBeenCalledTimes(reads);
      expect(mocks.archive).toHaveBeenCalledTimes(writes);
      expect(mocks.toastWarning).toHaveBeenCalledOnce();
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledOnce();

      releaseRefresh();
    });

    it('keeps what committed before a cancelled prompt in the summary', async () => {
      mocks.delete.mockImplementationOnce(() => Promise.resolve({ deleted: true }));
      mocks.delete.mockImplementationOnce(() => Promise.reject(reauthRequired()));
      const requestReauth = vi.fn().mockRejectedValue(new AdminReauthCancelledError());

      openBulkDeleteAgentsModal({ rows: [row('a'), row('b')], t });
      await submitLastModal({ requestReauth });

      expect(mocks.delete).toHaveBeenCalledTimes(2);
      expect(String(mocks.toastWarning.mock.calls[0]![0])).toContain(
        'agentCatalog.toast.bulkCancelled',
      );
      expect(String(mocks.toastWarning.mock.calls[0]![0])).toContain('agentCatalog.toast.bulkDone');
    });
  });
});
