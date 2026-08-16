import type { AdminResourceStatus } from '../primitives/statusBadge.utils';

/** Map provider lifecycle status onto StatusBadge semantic tokens. */
export const toIdentityProviderStatusBadge = (
  status: string | null | undefined,
): AdminResourceStatus => {
  switch (status) {
    case 'draft': {
      return 'draft';
    }
    case 'published': {
      return 'published';
    }
    case 'pending_restart': {
      return 'pending';
    }
    case 'active': {
      return 'active';
    }
    case 'error': {
      return 'error';
    }
    case 'disabled': {
      return 'disabled';
    }
    case 'archived': {
      return 'archived';
    }
    default: {
      return 'unknown';
    }
  }
};

/**
 * Published-history signal for draft heads.
 * Never conflate lookup failure/loading with "never published" — those are `unknown`.
 * After publish→edit/secret-clear the mutable head is draft with activationRevision=null,
 * but a prior published revision may still be live and must remain tombstoneable.
 */
export type PublishedHistorySignal = 'has-history' | 'no-history' | 'unknown';

export const resolvePublishedHistorySignal = (
  byId: Record<string, PublishedHistorySignal>,
  id: string,
): PublishedHistorySignal => byId[id] ?? 'unknown';

/**
 * Disable (tombstone) when the provider is live, or a draft that has (or may have)
 * published history. On `unknown` (loading/lookup error), fail safe toward revocation.
 */
export const isIdentityProviderDisableable = (
  provider: { status: string },
  publishedHistory: PublishedHistorySignal,
): boolean => {
  if (
    provider.status === 'active' ||
    provider.status === 'pending_restart' ||
    provider.status === 'published' ||
    provider.status === 'error'
  ) {
    return true;
  }
  if (provider.status === 'draft') {
    return publishedHistory === 'has-history' || publishedHistory === 'unknown';
  }
  return false;
};

/**
 * Hard-delete only when the draft is confirmed never-published.
 * `unknown` must not offer Delete — the backend rejects delete for providers with history.
 */
export const isIdentityProviderDeletable = (
  provider: { status: string },
  publishedHistory: PublishedHistorySignal,
): boolean => provider.status === 'draft' && publishedHistory === 'no-history';
