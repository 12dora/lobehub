import type {
  EgressScopeState,
  NetworkProxyConfigView,
  NetworkProxyFeatureKey,
} from '@/types/platform/networkProxy';

import type { NetworkProxyProviderOption } from '../hooks';

export interface ProviderScopeRow {
  catalogEnabled: boolean;
  /** True when the provider only exists because it still carries a scope. */
  delisted: boolean;
  id: string;
  name: string;
  scope: EgressScopeState;
}

export interface ProviderFilters {
  name?: string;
  /** `enabled` / `disabled`, matched against `catalogEnabled`. */
  status?: string;
}

export interface FeatureScopeRow {
  key: NetworkProxyFeatureKey;
  scope: EgressScopeState;
}

export const OFF_SCOPE: EgressScopeState = { enabled: false, onUnavailable: 'direct' };

/**
 * Providers that the server-side runtime cannot route because the browser talks to them
 * directly (design §3.5). Ollama with `fetchOnClient` is the only case today.
 */
export const BROWSER_DIRECT_PROVIDERS = new Set(['ollama']);

/** The catalogue plus anything still carrying a scope, filtered and ordered for the table. */
export const buildProviderScopeRows = (
  providers: NetworkProxyProviderOption[],
  scopes: NetworkProxyConfigView['scopes']['providers'],
  filters: ProviderFilters,
): ProviderScopeRow[] => {
  const known = new Map(providers.map((provider) => [provider.id, provider]));
  const rows: ProviderScopeRow[] = [...known.values()].map((provider) => ({
    catalogEnabled: provider.enabled,
    delisted: false,
    id: provider.id,
    name: provider.name,
    scope: scopes[provider.id] ?? OFF_SCOPE,
  }));
  // A provider that was scoped and later removed from the catalog must stay visible —
  // otherwise its switch would be stuck on with no way to turn it off.
  for (const [id, scope] of Object.entries(scopes)) {
    if (known.has(id)) continue;
    rows.push({ catalogEnabled: false, delisted: true, id, name: id, scope });
  }
  const needle = filters.name?.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (
      needle &&
      !row.name.toLowerCase().includes(needle) &&
      !row.id.toLowerCase().includes(needle)
    )
      return false;
    if (filters.status === 'enabled' && !row.catalogEnabled) return false;
    if (filters.status === 'disabled' && row.catalogEnabled) return false;
    return true;
  });
  // Providers the platform actually serves come first; the long tail of catalogue entries
  // nobody enabled would otherwise bury them. Sort on the catalogue flag, never on the
  // routing switch — rows must not jump the moment an admin flips one.
  return visible.sort((a, b) => Number(b.catalogEnabled) - Number(a.catalogEnabled));
};
