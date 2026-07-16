/**
 * Admin high-risk re-authentication controller (Better Auth path).
 *
 * Opens a real sign-in flow in a popup, keeps the pending mutation callback only
 * in memory (never localStorage / sessionStorage / URL / logs), and resolves
 * only after a same-origin success signal or cancel/block.
 *
 * OIDC adapter seam is reserved for M11 — this implementation does not claim OIDC.
 */

export const ADMIN_REAUTH_MESSAGE_TYPE = 'lobehub.admin.reauth' as const;
export const ADMIN_REAUTH_COMPLETE_PATH = '/admin/reauth-complete';

export type AdminReauthMessage =
  | { type: typeof ADMIN_REAUTH_MESSAGE_TYPE; status: 'success' }
  | { type: typeof ADMIN_REAUTH_MESSAGE_TYPE; status: 'cancel' };

export class AdminReauthCancelledError extends Error {
  readonly code = 'ADMIN_REAUTH_CANCELLED';
  constructor(message = 'Admin re-authentication cancelled') {
    super(message);
    this.name = 'AdminReauthCancelledError';
  }
}

export class AdminReauthBlockedError extends Error {
  readonly code = 'ADMIN_REAUTH_BLOCKED';
  constructor(message = 'Admin re-authentication popup was blocked') {
    super(message);
    this.name = 'AdminReauthBlockedError';
  }
}

export interface RequestAdminReauthOptions {
  /**
   * Injectable window open (tests). Defaults to window.open.
   */
  openWindow?: (url: string, target: string, features: string) => Window | null;
  /**
   * Injectable origin (tests). Defaults to window.location.origin.
   */
  origin?: string;
  /**
   * Poll interval while waiting for popup close without success message.
   */
  pollMs?: number;
}

/**
 * Launch Better Auth sign-in in a popup and wait for same-origin success.
 * Rejects with AdminReauthCancelledError / AdminReauthBlockedError.
 */
export const requestAdminReauth = (options: RequestAdminReauthOptions = {}): Promise<void> => {
  if (typeof window === 'undefined') {
    return Promise.reject(new AdminReauthBlockedError('No window'));
  }

  const origin = options.origin ?? window.location.origin;
  const openWindow = options.openWindow ?? window.open.bind(window);
  const pollMs = options.pollMs ?? 400;

  const callbackUrl = `${origin}${ADMIN_REAUTH_COMPLETE_PATH}`;
  const signInUrl = `${origin}/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`;

  const popup = openWindow(signInUrl, 'lobehub-admin-reauth', 'width=480,height=720');
  if (!popup) {
    return Promise.reject(new AdminReauthBlockedError());
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(timer);
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onMessage = (event: MessageEvent) => {
      // Never trust unverified origins.
      if (event.origin !== origin) return;
      const data = event.data as AdminReauthMessage | null;
      if (!data || data.type !== ADMIN_REAUTH_MESSAGE_TYPE) return;

      if (data.status === 'success') {
        settle(() => {
          try {
            popup.close();
          } catch {
            // ignore
          }
          resolve();
        });
        return;
      }

      if (data.status === 'cancel') {
        settle(() => {
          try {
            popup.close();
          } catch {
            // ignore
          }
          reject(new AdminReauthCancelledError());
        });
      }
    };

    window.addEventListener('message', onMessage);

    const timer = window.setInterval(() => {
      if (!popup.closed) return;
      // Closed without success message → cancel (do not invent success).
      settle(() => reject(new AdminReauthCancelledError()));
    }, pollMs);
  });
};

/**
 * Run `fn`; on ADMIN_REAUTH_REQUIRED, launch reauth then retry exactly once.
 * Cancel / blocked leaves the original error path to the caller (rethrow cancel).
 */
export const withAdminReauthRetry = async <T>(
  fn: () => Promise<T>,
  options?: RequestAdminReauthOptions & {
    isReauthError?: (error: unknown) => boolean;
    requestReauth?: () => Promise<void>;
  },
): Promise<T> => {
  const isReauthError =
    options?.isReauthError ??
    ((error: unknown) => {
      const message =
        typeof error === 'string'
          ? error
          : error && typeof error === 'object' && 'message' in error
            ? String((error as { message?: unknown }).message ?? '')
            : '';
      if (message.includes('ADMIN_REAUTH_REQUIRED')) return true;
      const data = (error as { data?: { errorData?: { code?: string }; code?: string } })?.data;
      const code = data?.errorData?.code ?? data?.code;
      return code === 'ADMIN_REAUTH_REQUIRED';
    });

  const requestReauth = options?.requestReauth ?? (() => requestAdminReauth(options));

  try {
    return await fn();
  } catch (error) {
    if (!isReauthError(error)) throw error;
    await requestReauth();
    // Exactly one retry after successful reauth.
    return await fn();
  }
};
