/**
 * Post-commit refresh for settings policy mutations.
 *
 * Mutations must treat the committed local CAS/token/draft as authoritative.
 * A failed refresh is not a mutation failure — surface a retry-only error and
 * never re-hydrate from stale SWR data until refresh succeeds.
 */

export type PostCommitRefreshResult = { ok: true } | { error: string; ok: false };

export const runPostCommitRefresh = async (params: {
  errorMessage: string;
  mutate: () => Promise<unknown>;
  refresh?: () => Promise<unknown>;
}): Promise<PostCommitRefreshResult> => {
  try {
    await params.mutate();
    if (params.refresh) await params.refresh();
    return { ok: true };
  } catch {
    return { error: params.errorMessage, ok: false };
  }
};
