import { NETWORK_PROXY_DEFAULTS, NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';
import type {
  NetworkProxySubscriptionKind,
  SubscriptionCreate,
  SubscriptionUpdate,
  SubscriptionView,
} from '@/types/platform/networkProxy';

export interface SubscriptionFormState {
  enabled: boolean;
  excludeFilter: string;
  filter: string;
  kind: NetworkProxySubscriptionKind;
  name: string;
  /** `manual` only: share links (one per line) or a Clash `proxies:` snippet. */
  payload: string;
  updateIntervalSec: number;
  /** `url` only. Left blank on edit = keep the stored URL (it is never returned). */
  url: string;
  userAgent: string;
}

export const createSubscriptionFormState = (view?: SubscriptionView): SubscriptionFormState => ({
  enabled: view?.enabled ?? true,
  excludeFilter: view?.excludeFilter ?? '',
  filter: view?.filter ?? '',
  kind: view?.kind ?? 'url',
  name: view?.name ?? '',
  payload: '',
  updateIntervalSec:
    view?.updateIntervalSec ?? NETWORK_PROXY_DEFAULTS.SUBSCRIPTION_UPDATE_INTERVAL_SEC,
  url: '',
  userAgent: view?.userAgent ?? '',
});

export type SubscriptionFormError =
  | 'intervalRange'
  | 'nameRequired'
  | 'payloadRequired'
  | 'payloadTooLong'
  | 'urlInvalid'
  | 'urlRequired';

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Client-side pre-flight only — the server re-validates and additionally applies SSRF policy. */
export const validateSubscriptionForm = (
  state: SubscriptionFormState,
  mode: 'create' | 'edit',
): SubscriptionFormError | null => {
  if (!state.name.trim()) return 'nameRequired';
  if (state.kind === 'url') {
    if (!state.url.trim()) {
      // On edit an empty URL means "keep the stored one".
      if (mode === 'create') return 'urlRequired';
    } else if (!isHttpUrl(state.url.trim())) return 'urlInvalid';
    if (
      state.updateIntervalSec < NETWORK_PROXY_LIMITS.SUBSCRIPTION_UPDATE_INTERVAL_MIN_SEC ||
      state.updateIntervalSec > NETWORK_PROXY_LIMITS.SUBSCRIPTION_UPDATE_INTERVAL_MAX_SEC
    ) {
      return 'intervalRange';
    }
    return null;
  }
  if (mode === 'create' && !state.payload.trim()) return 'payloadRequired';
  if (state.payload.length > NETWORK_PROXY_LIMITS.MANUAL_PAYLOAD_MAX_CHARS) return 'payloadTooLong';
  return null;
};

export const buildSubscriptionCreate = (
  state: SubscriptionFormState,
  sortOrder: number,
): SubscriptionCreate => {
  const common = {
    enabled: state.enabled,
    name: state.name.trim(),
    sortOrder,
    ...(state.filter.trim() ? { filter: state.filter.trim() } : {}),
    ...(state.excludeFilter.trim() ? { excludeFilter: state.excludeFilter.trim() } : {}),
  };
  if (state.kind === 'manual') {
    return { ...common, kind: 'manual', payload: state.payload };
  }
  return {
    ...common,
    kind: 'url',
    updateIntervalSec: state.updateIntervalSec,
    url: state.url.trim(),
    ...(state.userAgent.trim() ? { userAgent: state.userAgent.trim() } : {}),
  };
};

/**
 * Only the fields the admin actually changed. Blank secrets (`url`, `payload`) are omitted so an
 * edit of the display name can never wipe a subscription's credentials — the server keeps them.
 */
export const buildSubscriptionUpdate = (
  original: SubscriptionView,
  state: SubscriptionFormState,
): SubscriptionUpdate => {
  const patch: SubscriptionUpdate = { id: original.id };
  const name = state.name.trim();
  if (name !== original.name) patch.name = name;
  if (state.enabled !== original.enabled) patch.enabled = state.enabled;

  const filter = state.filter.trim();
  if (filter !== (original.filter ?? '')) patch.filter = filter || null;
  const excludeFilter = state.excludeFilter.trim();
  if (excludeFilter !== (original.excludeFilter ?? '')) patch.excludeFilter = excludeFilter || null;

  if (state.kind === 'url') {
    if (state.updateIntervalSec !== original.updateIntervalSec) {
      patch.updateIntervalSec = state.updateIntervalSec;
    }
    const userAgent = state.userAgent.trim();
    if (userAgent !== (original.userAgent ?? '')) patch.userAgent = userAgent || null;
    if (state.url.trim()) patch.url = state.url.trim();
  } else if (state.payload.trim()) {
    patch.payload = state.payload;
  }
  return patch;
};

/** New rows land at the end of the list. */
export const nextSortOrder = (items: readonly SubscriptionView[]): number =>
  items.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;
