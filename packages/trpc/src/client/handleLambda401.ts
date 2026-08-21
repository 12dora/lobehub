/**
 * Probe Better Auth after a lambda 401 before destroying the session.
 *
 * A Redis blip or getSession throw used to surface as UNAUTHORIZED; calling
 * `logout()` then revoked a still-valid cookie. Only sign out when get-session
 * itself says there is no user.
 */

export type SessionProbeResult = 'authenticated' | 'unauthenticated' | 'unknown';

const GET_SESSION_PATH = '/api/auth/get-session';

const hasSessionUser = (body: unknown): boolean => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const user = (body as { user?: unknown }).user;
  if (!user || typeof user !== 'object' || Array.isArray(user)) return false;
  const id = (user as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0;
};

export const probeBetterAuthSession = async (
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SessionProbeResult> => {
  try {
    const response = await fetchImpl(GET_SESSION_PATH, {
      cache: 'no-store',
      credentials: 'include',
      method: 'GET',
    });

    if (response.status === 401) return 'unauthenticated';
    if (!response.ok) return 'unknown';

    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('application/json')) return 'unknown';

    const body: unknown = await response.json();
    return hasSessionUser(body) ? 'authenticated' : 'unauthenticated';
  } catch {
    return 'unknown';
  }
};

export const shouldLogoutAfterSessionProbe = (result: SessionProbeResult): boolean =>
  result === 'unauthenticated';

export interface HandleNonAdminLambda401Params {
  isSignedIn: boolean;
  logout: () => Promise<void> | void;
  redirectToLogin: () => void;
}

let inFlightHandle: Promise<void> | null = null;

/**
 * Concurrent 401s share a single get-session probe + at most one logout.
 * Network / 5xx probe results are a no-op (the original tRPC error still surfaces).
 */
export const handleNonAdminLambda401 = async (
  params: HandleNonAdminLambda401Params,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> => {
  if (!inFlightHandle) {
    inFlightHandle = (async () => {
      const result = await probeBetterAuthSession(fetchImpl);
      if (!shouldLogoutAfterSessionProbe(result)) return;
      if (params.isSignedIn) {
        await params.logout();
      }
      params.redirectToLogin();
    })().finally(() => {
      inFlightHandle = null;
    });
  }

  return inFlightHandle;
};

/** Test-only: drop the in-flight probe so cases stay isolated. */
export const resetHandleLambda401State = () => {
  inFlightHandle = null;
};
