'use client';

import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type AdminAccessSnapshot,
  type FetchAdminAccess,
  fetchAdminAccess as defaultFetchAdminAccess,
  isAdminAccessErrorRetryable,
} from '../services/adminAuth';

/**
 * Explicit access lifecycle for the admin shell.
 * Child admin business data must mount only when status === 'allowed'.
 */
export type AdminAccessStatus = 'loading' | 'allowed' | 'forbidden' | 'error';

export interface AdminAccessContextValue {
  /**
   * Server-authenticated method for reauth routing. Null when unknown / not allowed.
   */
  authMethod: AdminAccessSnapshot['authMethod'];
  error: Error | null;
  /** Granted permission codes when allowed; empty otherwise. */
  permissions: readonly string[];
  refresh: () => Promise<void>;
  /** True when the last failure may be fixed by retry (not 401/403). */
  retryable: boolean;
  roles: AdminAccessSnapshot['roles'];
  status: AdminAccessStatus;
}

const AdminAccessContext = createContext<AdminAccessContextValue | null>(null);

export interface AdminAccessProviderProps {
  children: ReactNode;
  /**
   * When false, skip the access query (feature flag off / gate already redirected).
   * Defaults to true.
   */
  enabled?: boolean;
  /**
   * Injected fetch for tests. Production uses lambdaClient.admin.auth.getMyAccess.
   */
  fetchAccess?: FetchAdminAccess;
}

/**
 * Loads `admin.auth.getMyAccess` for authenticated users.
 * Does not persist permissions. Does not authorize from capabilities.adminAccess.
 */
export default function AdminAccessProvider({
  children,
  fetchAccess = defaultFetchAdminAccess,
  enabled = true,
}: AdminAccessProviderProps) {
  const [status, setStatus] = useState<AdminAccessStatus>('loading');
  const [permissions, setPermissions] = useState<readonly string[]>([]);
  const [roles, setRoles] = useState<AdminAccessSnapshot['roles']>([]);
  const [authMethod, setAuthMethod] = useState<AdminAccessSnapshot['authMethod']>(null);
  const [error, setError] = useState<Error | null>(null);
  const [retryable, setRetryable] = useState(false);
  const fetchRef = useRef(fetchAccess);
  fetchRef.current = fetchAccess;
  /** Monotonic generation: only the latest load() may commit results (out-of-order guard). */
  const loadGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;

    if (!enabled) {
      if (generation !== loadGenerationRef.current || !mountedRef.current) return;
      setStatus('forbidden');
      setPermissions([]);
      setRoles([]);
      setAuthMethod(null);
      setError(null);
      setRetryable(false);
      return;
    }

    setStatus('loading');
    setError(null);
    setRetryable(false);

    try {
      const snapshot = await fetchRef.current();
      // Drop stale responses: a newer refresh (or disable/unmount) superseded this request.
      if (generation !== loadGenerationRef.current || !mountedRef.current) return;
      setAuthMethod(snapshot.authMethod ?? null);
      if (snapshot.hasAdminAccess) {
        setStatus('allowed');
        setPermissions(snapshot.permissions);
        setRoles(snapshot.roles);
      } else {
        setStatus('forbidden');
        setPermissions([]);
        setRoles(snapshot.roles);
      }
    } catch (err) {
      if (generation !== loadGenerationRef.current || !mountedRef.current) return;
      const nextError = err instanceof Error ? err : new Error(String(err));
      setError(nextError);
      setPermissions([]);
      setRoles([]);
      setAuthMethod(null);
      setRetryable(isAdminAccessErrorRetryable(err));
      setStatus('error');
    }
  }, [enabled]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      // Invalidate any in-flight load so its resolution cannot repaint after unmount/remount races.
      loadGenerationRef.current += 1;
    };
  }, [load]);

  const value = useMemo<AdminAccessContextValue>(
    () => ({
      authMethod,
      error,
      permissions,
      refresh: load,
      retryable,
      roles,
      status,
    }),
    [authMethod, error, permissions, load, retryable, roles, status],
  );

  return <AdminAccessContext value={value}>{children}</AdminAccessContext>;
}

export const useAdminAccess = (): AdminAccessContextValue => {
  const ctx = use(AdminAccessContext);
  if (!ctx) {
    throw new Error('useAdminAccess must be used within AdminAccessProvider');
  }
  return ctx;
};

/** Safe hook for optional trees — returns null outside the provider. */
export const useOptionalAdminAccess = (): AdminAccessContextValue | null => use(AdminAccessContext);
