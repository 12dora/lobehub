'use client';

import { toast } from '@lobehub/ui/base-ui';
import i18n from 'i18next';

import {
  type AdminReauthAuthMethod,
  AdminReauthBlockedError,
  AdminReauthCancelledError,
  withAdminReauthRetry,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { getAdminUsersMutationErrorKey } from '@/enterprise/client/features/admin/users/utils';

export interface RunAdminMutationOptions {
  /** Trusted server auth method from getMyAccess — drives the interactive reauth retry. */
  authMethod?: AdminReauthAuthMethod | null;
  /** Map a non-reauth failure to an `admin` namespace i18n key. */
  mapErrorKey?: (error: unknown) => string;
  /**
   * Present the failure yourself (inline banner, editor state, …). When provided the default
   * error toast is suppressed — the caller owns the whole error surface.
   */
  onError?: (error: unknown) => Promise<void> | void;
  /** The mutation. Runs at most twice: once, then again after a successful interactive reauth. */
  run: () => Promise<void>;
}

/** Reauth failures have their own copy; everything else goes through the shared admin mapping. */
const resolveErrorKey = (error: unknown, mapErrorKey?: (error: unknown) => string): string => {
  if (error instanceof AdminReauthCancelledError) return 'users.errors.reauthCancelled';
  if (error instanceof AdminReauthBlockedError) return 'users.errors.reauthBlocked';
  return mapErrorKey ? mapErrorKey(error) : getAdminUsersMutationErrorKey(error);
};

/**
 * Run an admin write that does NOT collect an audit reason.
 *
 * Replaces `openReasonModal` for non-destructive operations (save / publish / toggle / test /
 * rollout …): the reason prompt is gone, but the two things the modal really provided stay —
 * the one-shot interactive reauth retry and a single user-visible failure surface.
 *
 * Returns `true` only when the mutation committed, so callers can drive their write locks.
 */
export const runAdminMutation = async ({
  authMethod,
  mapErrorKey,
  onError,
  run,
}: RunAdminMutationOptions): Promise<boolean> => {
  try {
    await withAdminReauthRetry(run, { authMethod: authMethod ?? null });
    return true;
  } catch (error) {
    if (onError) await onError(error);
    else toast.error(String(i18n.t(resolveErrorKey(error, mapErrorKey) as never, { ns: 'admin' })));
    return false;
  }
};
