import { describe, expect, it, vi } from 'vitest';

import type { DraftMap } from './settingsPolicyController';
import {
  type ResetOrchestrationDeps,
  type ResetPartialFailure,
  runResetDefaultsConfirm,
  runRetryResetRestore,
  type SettingsPolicyResetTransition,
} from './settingsPolicyReset';

const priorDraft = {
  'general.fontSize': {
    mode: 'locked' as const,
    schemaVersion: 1,
    value: 'kept',
    visibility: 'hidden' as const,
  },
} as DraftMap;

const baseToken = 'a'.repeat(64);
const committedToken = 'c'.repeat(64);
const restoredToken = 'd'.repeat(64);

const makeDeps = (overrides?: {
  isRevisionConflict?: ResetOrchestrationDeps['isRevisionConflict'];
  mapError?: ResetOrchestrationDeps['mapError'];
  publishWithReauth?: ResetOrchestrationDeps['publishWithReauth'];
  service?: {
    publish?: ReturnType<typeof vi.fn>;
    saveDraft?: ReturnType<typeof vi.fn>;
  };
}) => {
  const apply = vi.fn<(t: SettingsPolicyResetTransition) => void>();
  const onConflict = vi.fn(async () => {});
  const onRefreshAfterCommit = vi.fn(async () => {});
  const onToastError = vi.fn<(kind: 'resetFailed' | 'resetPartial' | 'restoreFailed') => void>();
  const onToastSuccess = vi.fn<(kind: 'reset' | 'retryRestore') => void>();
  const publish =
    overrides?.service?.publish ?? vi.fn().mockResolvedValue({ auditId: 'a1', revision: 2 });
  const saveDraft =
    overrides?.service?.saveDraft ??
    vi.fn().mockResolvedValue({
      baseRevision: 2,
      draftToken: committedToken,
    });
  return {
    apply,
    isRevisionConflict: overrides?.isRevisionConflict ?? (() => false),
    mapError:
      overrides?.mapError ?? ((err: unknown) => (err instanceof Error ? err.message : String(err))),
    onConflict,
    onRefreshAfterCommit,
    onToastError,
    onToastSuccess,
    publishWithReauth:
      overrides?.publishWithReauth ?? (async (run: () => Promise<unknown>) => run()),
    service: {
      publish,
      saveDraft,
    },
  };
};

describe('settingsPolicyReset orchestration', () => {
  describe('runResetDefaultsConfirm', () => {
    it('commit → publish → restore happy path dispatches ADOPT then RESET_PUBLISHED', async () => {
      const deps = makeDeps();

      await runResetDefaultsConfirm({
        ...deps,
        baseToken,
        priorBaseRevision: 1,
        priorDraft,
        reason: 'reset',
        registryVersion: 1,
      });

      expect(deps.service.saveDraft).toHaveBeenCalledTimes(1);
      expect(deps.service.saveDraft).toHaveBeenCalledWith({
        draft: {},
        expectedDraftToken: baseToken,
        reason: 'reset',
      });
      expect(deps.service.publish).toHaveBeenCalledWith({
        expectedDraftToken: committedToken,
        expectedRevision: 2,
        reason: 'reset',
      });
      expect(deps.apply.mock.calls.map((c) => c[0].kind)).toEqual([
        'ADOPT_EMPTY_DRAFT',
        'RESET_PUBLISHED',
      ]);
      expect(deps.apply).toHaveBeenNthCalledWith(1, {
        kind: 'ADOPT_EMPTY_DRAFT',
        baseRevision: 2,
        draftToken: committedToken,
      });
      expect(deps.apply).toHaveBeenNthCalledWith(2, {
        kind: 'RESET_PUBLISHED',
        priorBaseRevision: 1,
        registryVersion: 1,
      });
      expect(deps.onRefreshAfterCommit).toHaveBeenCalledOnce();
      expect(deps.onToastError).not.toHaveBeenCalled();
      expect(deps.onToastSuccess).toHaveBeenCalledWith('reset');
    });

    it('enters RESET_PARTIAL_FAILURE when publish and restore both fail', async () => {
      const deps = makeDeps({
        service: {
          publish: vi.fn().mockRejectedValue(new Error('publish failed')),
          saveDraft: vi
            .fn()
            .mockResolvedValueOnce({ baseRevision: 2, draftToken: committedToken })
            .mockRejectedValueOnce(new Error('restore interrupted')),
        },
      });

      await runResetDefaultsConfirm({
        ...deps,
        baseToken,
        priorBaseRevision: 1,
        priorDraft,
        reason: 'reset',
        registryVersion: 1,
      });

      expect(deps.service.saveDraft).toHaveBeenCalledTimes(2);
      expect(deps.service.saveDraft.mock.calls[1]?.[0]).toMatchObject({
        draft: priorDraft,
        expectedDraftToken: committedToken,
        reason: 'reset (restore)',
      });
      expect(deps.apply.mock.calls.map((c) => c[0].kind)).toEqual([
        'ADOPT_EMPTY_DRAFT',
        'RESET_PARTIAL_FAILURE',
      ]);
      const partialCall = deps.apply.mock.calls[1]?.[0] as Extract<
        SettingsPolicyResetTransition,
        { kind: 'RESET_PARTIAL_FAILURE' }
      >;
      expect(partialCall.partial).toMatchObject({
        committedBaseRevision: 2,
        committedDraftToken: committedToken,
        lastError: 'publish failed · restore interrupted',
        priorDraft,
        reason: 'reset',
      });
      expect(deps.onToastError).toHaveBeenCalledWith('resetPartial');
      expect(deps.onRefreshAfterCommit).not.toHaveBeenCalled();
    });
  });

  describe('runRetryResetRestore', () => {
    const partial: ResetPartialFailure = {
      committedBaseRevision: 2,
      committedDraftToken: committedToken,
      lastError: 'publish failed · restore interrupted',
      priorDraft,
      reason: 'reset',
    };

    it('restores prior draft, refreshes, and toasts success', async () => {
      const deps = makeDeps({
        service: {
          saveDraft: vi.fn().mockResolvedValue({
            baseRevision: 3,
            draftToken: restoredToken,
          }),
        },
      });

      await runRetryResetRestore({ ...deps, partial });

      expect(deps.service.saveDraft).toHaveBeenCalledWith({
        draft: priorDraft,
        expectedDraftToken: committedToken,
        reason: 'reset (restore)',
      });
      expect(deps.apply).toHaveBeenCalledWith({
        kind: 'RESTORED',
        baseRevision: 3,
        draft: priorDraft,
        draftToken: restoredToken,
      });
      expect(deps.onRefreshAfterCommit).toHaveBeenCalledOnce();
      expect(deps.onToastSuccess).toHaveBeenCalledWith('retryRestore');
      expect(deps.onToastError).not.toHaveBeenCalled();
    });

    it('keeps partial state and updates lastError when restore fails again', async () => {
      const deps = makeDeps({
        service: {
          saveDraft: vi.fn().mockRejectedValue(new Error('still down')),
        },
      });

      await runRetryResetRestore({ ...deps, partial });

      expect(deps.apply).toHaveBeenCalledWith({
        kind: 'UPDATE_PARTIAL_LAST_ERROR',
        lastError: 'still down',
        // ASI-002: the recovery context must survive a failed retry.
        prior: partial,
      });
      expect(deps.onToastError).toHaveBeenCalledWith('restoreFailed');
      expect(deps.onRefreshAfterCommit).not.toHaveBeenCalled();
    });
  });
});
