/**
 * Admin high-risk re-authentication controller.
 *
 * - Cryptographic one-time state bound to the exact popup (source + origin + state).
 * - AbortSignal/cancel cleans listeners and ignores late success messages.
 * - Better Auth sign-in popup with `reauth=1` so OAuth can force prompt=login/max_age=0.
 * - OIDC/Authentik uses the existing Better Auth OAuth2 additionalData path.
 * - M11 adapter seam: authMethod selects strategy; only BA/OIDC-via-BA is implemented.
 */

export const ADMIN_REAUTH_MESSAGE_TYPE = 'lobehub.admin.reauth' as const;
export const ADMIN_REAUTH_COMPLETE_PATH = '/admin/reauth-complete';

export type AdminReauthAuthMethod = 'better-auth' | 'oidc' | 'api-key' | 'dev-mock' | null;

export type AdminReauthMessage = {
  status: 'success' | 'cancel';
  /** Cryptographic state echoed from the callback URL — never a secret payload. */
  state: string;
  type: typeof ADMIN_REAUTH_MESSAGE_TYPE;
};

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

/** Generate URL-safe crypto state (no Math.random). */
export const createAdminReauthState = (
  randomSource: { getRandomValues: (a: Uint8Array) => Uint8Array } = crypto,
): string => {
  const bytes = new Uint8Array(32);
  randomSource.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export interface RequestAdminReauthOptions {
  /**
   * Trusted server auth method from getMyAccess (not a client guess).
   * api-key cannot reauth interactively.
   */
  authMethod?: AdminReauthAuthMethod;
  /** Injectable crypto for tests. */
  createState?: () => string;
  openWindow?: (url: string, target: string, features: string) => Window | null;
  origin?: string;
  pollMs?: number;
  /** Abort cancels the flow; late success must not resolve. */
  signal?: AbortSignal;
}

/**
 * Launch sign-in popup with reauth=1 + cryptographic state.
 * Accepts completion only when origin, event.source, type, status, and state match.
 */
export const requestAdminReauth = (options: RequestAdminReauthOptions = {}): Promise<void> => {
  if (typeof window === 'undefined') {
    return Promise.reject(new AdminReauthBlockedError('No window'));
  }

  if (options.authMethod === 'api-key') {
    return Promise.reject(
      new AdminReauthBlockedError('API key sessions cannot complete interactive reauth'),
    );
  }

  if (options.signal?.aborted) {
    return Promise.reject(new AdminReauthCancelledError());
  }

  const origin = options.origin ?? window.location.origin;
  const openWindow = options.openWindow ?? window.open.bind(window);
  const pollMs = options.pollMs ?? 400;
  const state = (options.createState ?? createAdminReauthState)();

  // Only non-secret state in the callback URL — never reason/payload/token.
  const callbackUrl = `${origin}${ADMIN_REAUTH_COMPLETE_PATH}?state=${encodeURIComponent(state)}`;
  // reauth=1 enables prompt=login / max_age=0 on OAuth providers via additionalData.
  const signInUrl = `${origin}/signin?reauth=1&callbackUrl=${encodeURIComponent(callbackUrl)}`;

  const popup = openWindow(signInUrl, 'lobehub-admin-reauth', 'width=480,height=720');
  if (!popup) {
    return Promise.reject(new AdminReauthBlockedError());
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let expectedState: string | null = state;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      expectedState = null; // one-time consume
      cleanup();
      fn();
    };

    const onAbort = () => {
      settle(() => {
        try {
          popup.close();
        } catch {
          // ignore
        }
        reject(new AdminReauthCancelledError());
      });
    };

    const onMessage = (event: MessageEvent) => {
      if (settled) return;
      // Cryptographic binding: origin + exact popup source + type + state.
      if (event.origin !== origin) return;
      if (event.source !== popup) return;
      const data = event.data as AdminReauthMessage | null;
      if (!data || data.type !== ADMIN_REAUTH_MESSAGE_TYPE) return;
      if (!expectedState || data.state !== expectedState) return;

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
    options.signal?.addEventListener('abort', onAbort);

    const timer = window.setInterval(() => {
      if (!popup.closed) return;
      settle(() => reject(new AdminReauthCancelledError()));
    }, pollMs);
  });
};

export const isAdminReauthRequiredError = (error: unknown): boolean => {
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
};

/**
 * Run `fn`; on ADMIN_REAUTH_REQUIRED, launch reauth then retry exactly once.
 * Abort/cancel never retries.
 */
export const withAdminReauthRetry = async <T>(
  fn: () => Promise<T>,
  options?: RequestAdminReauthOptions & {
    isReauthError?: (error: unknown) => boolean;
    requestReauth?: () => Promise<void>;
  },
): Promise<T> => {
  const isReauthError = options?.isReauthError ?? isAdminReauthRequiredError;
  const requestReauth = options?.requestReauth ?? (() => requestAdminReauth(options));

  try {
    return await fn();
  } catch (error) {
    if (!isReauthError(error)) throw error;
    if (options?.signal?.aborted) throw new AdminReauthCancelledError();
    await requestReauth();
    if (options?.signal?.aborted) throw new AdminReauthCancelledError();
    return await fn();
  }
};
