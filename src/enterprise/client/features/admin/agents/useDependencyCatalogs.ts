'use client';

import { useEffect, useMemo, useState } from 'react';

import { usable } from './dependencyEditorShared';
import type { AdminAgentDraftDependencies } from './types';
import {
  useAdminConnectorDetail,
  useAdminConnectorDetails,
  useAdminProviderModelSource,
  useAdminPublishedConnectors,
  useAdminPublishedProviders,
  useAdminPublishedSkills,
} from './useDependencyCatalog';

const CATALOG_SEARCH_DEBOUNCE_MS = 250;

/** Debounce a string for server-side catalog search keys without embedding timers in fields. */
const useDebouncedQuery = (value: string, delay = CATALOG_SEARCH_DEBOUNCE_MS) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(handle);
  }, [delay, value]);
  return debounced;
};

interface UseDependencyCatalogsParams {
  connectorId: string | undefined;
  dependencies: AdminAgentDraftDependencies;
  enabled: boolean;
}

export const useDependencyCatalogs = ({
  connectorId,
  dependencies,
  enabled,
}: UseDependencyCatalogsParams) => {
  const [providerSearch, setProviderSearch] = useState('');
  const [connectorSearch, setConnectorSearch] = useState('');
  const debouncedProviderQuery = useDebouncedQuery(providerSearch);
  const debouncedConnectorQuery = useDebouncedQuery(connectorSearch);
  // Hydration search: when an existing model ref's provider is not on the first unfiltered page,
  // re-key once with the providerKey so the exact option resolves via server search.
  const [providerHydrateQuery, setProviderHydrateQuery] = useState('');

  // The picker's own filter only sees the loaded page, so the typed query must reach the server —
  // a provider beyond the first page would otherwise be unreachable.
  const providers = useAdminPublishedProviders(
    enabled,
    providerHydrateQuery || debouncedProviderQuery,
  );
  const skills = useAdminPublishedSkills(enabled);
  const connectors = useAdminPublishedConnectors(enabled, debouncedConnectorQuery);

  const providerItems = providers.data?.items;
  const connectorItems = connectors.data?.items;

  const [providerId, setProviderId] = useState<string | undefined>();

  const source = useAdminProviderModelSource(providerId);
  const connectorDetail = useAdminConnectorDetail(connectorId);

  const model = dependencies.model;

  // Fetch the exact detail for every referenced connector so existing refs can be exact-validated.
  const referencedConnectorIds = useMemo(
    () => dependencies.connectors.map((connector) => connector.connectorId),
    [dependencies.connectors],
  );
  const connectorRefDetails = useAdminConnectorDetails(enabled ? referencedConnectorIds : []);

  const sourceSettled = usable(source);
  const skillsSettled = usable(skills);
  const connectorsSettled = usable(connectorRefDetails);
  // The provider list, connector list and currently-selected connector detail ALSO fail closed:
  // a revalidating/errored list is not trustworthy for authoring or for gating save readiness.
  const providersUsable = usable(providers);
  const connectorsListUsable = usable(connectors);
  const connectorDetailUsable = usable(connectorDetail);

  // Adapter slices so field components keep a simple items[] shape while SWR holds CatalogSearchPage.
  const providersSlice = {
    data: providerItems,
    error: providers.error,
    isLoading: providers.isLoading,
    isValidating: providers.isValidating,
    mutate: providers.mutate,
    truncated: Boolean(providers.data?.truncated),
  };
  const connectorsSlice = {
    data: connectorItems,
    error: connectors.error,
    isLoading: connectors.isLoading,
    isValidating: connectors.isValidating,
    mutate: connectors.mutate,
    truncated: Boolean(connectors.data?.truncated),
  };

  return {
    connectorDetail,
    connectorDetailUsable,
    connectorItems,
    connectorRefDetails,
    connectorSearch,
    connectors,
    connectorsListUsable,
    connectorsSettled,
    connectorsSlice,
    model,
    providerHydrateQuery,
    providerId,
    providerItems,
    providerSearch,
    providers,
    providersSlice,
    providersUsable,
    setConnectorSearch,
    setProviderHydrateQuery,
    setProviderId,
    setProviderSearch,
    skills,
    skillsSettled,
    source,
    sourceSettled,
  };
};
