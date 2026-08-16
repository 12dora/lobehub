'use client';

import { Flexbox } from '@lobehub/ui';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ConnectorDependencyField } from './ConnectorDependencyField';
import {
  allowedConnectorToolKeys,
  buildConnectorDependency,
  buildModelDependency,
  buildSkillDependency,
  isModelCurrent,
  staleConnectorKeys,
  staleSkillKeys,
  withConnectorAdded,
  withConnectorRemoved,
  withModel,
  withSkillAdded,
  withSkillRemoved,
} from './dependencyCatalog';
import { usable } from './dependencyEditorShared';
import { ModelDependencyField } from './ModelDependencyField';
import { SkillDependencyField } from './SkillDependencyField';
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

/**
 * A catalog state that blocks Save. Unlike `issues` (staleness, rendered next to the field it
 * belongs to), a blocker can originate from a field the host hides — Skills and Connectors live in
 * a collapsed group — so the host MUST render it where the Save button is.
 */
export interface DependencyBlocker {
  /** i18n key describing what is blocking Save. */
  message: string;
  /** Present when the underlying catalog exposes a retry. */
  retry?: () => Promise<unknown>;
}

export interface DependencyValidity {
  /** Save-blocking catalog loading/error states, including ones from hidden fields. */
  blockers: DependencyBlocker[];
  issues: string[];
  ready: boolean;
}

/** The three authorable dependency fields, so a caller can place them in different form sections. */
export interface DependencyEditorSlots {
  connectors: ReactNode;
  model: ReactNode;
  skills: ReactNode;
}

interface DependencyEditorProps {
  /** Owning Agent id — changing it resets the provider/connector selection so it never bleeds. */
  agentId: string;
  /**
   * Optional layout override. Catalog state, fail-closed readiness and authoring handlers stay in
   * this component; the caller only decides where each field is rendered. Omitted → stacked layout.
   */
  children?: (slots: DependencyEditorSlots) => ReactNode;
  dependencies: AdminAgentDraftDependencies;
  editable: boolean;
  enabled: boolean;
  onChange: (next: AdminAgentDraftDependencies) => void;
  onValidityChange?: (validity: DependencyValidity) => void;
}

export const DependencyEditor = ({
  agentId,
  children,
  dependencies,
  editable,
  enabled,
  onChange,
  onValidityChange,
}: DependencyEditorProps) => {
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
  const [connectorId, setConnectorId] = useState<string | undefined>();

  // Reset all selection state whenever the Agent context changes — never bleed across Agents.
  const agentRef = useRef(agentId);
  useEffect(() => {
    if (agentRef.current === agentId) return;
    agentRef.current = agentId;
    setProviderId(undefined);
    setConnectorId(undefined);
    setProviderSearch('');
    setConnectorSearch('');
    setProviderHydrateQuery('');
  }, [agentId]);

  // Initialise the provider selection from an existing model ref (edit / recovery).
  useEffect(() => {
    if (providerId || !dependencies.model || !providerItems) return;
    const match = providerItems.find(
      (provider) => provider.providerKey === dependencies.model!.providerKey,
    );
    if (match) {
      setProviderId(match.id);
      setProviderHydrateQuery('');
      return;
    }
    // Not on the current search page — ask the server for this providerKey once.
    if (!providerHydrateQuery) setProviderHydrateQuery(dependencies.model.providerKey);
  }, [dependencies.model, providerHydrateQuery, providerId, providerItems]);

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

  // Display staleness only once the relevant source has a settled success (no spurious "Outdated").
  const displayModelStale = Boolean(model) && sourceSettled && !isModelCurrent(model, source.data);
  const staleSkills = useMemo(
    () => (skillsSettled ? staleSkillKeys(dependencies.skills, skills.data) : []),
    [dependencies.skills, skills.data, skillsSettled],
  );
  const staleConnectors = useMemo(
    () =>
      connectorsSettled
        ? staleConnectorKeys(dependencies.connectors, connectorRefDetails.data)
        : [],
    [connectorRefDetails.data, connectorsSettled, dependencies.connectors],
  );

  // Readiness FAILS CLOSED. EVERY authorable dependency catalog must be freshly settled
  // (non-error, non-validating) — not just the ones the current draft already references — because
  // the operator can author from any of them. So an errored/revalidating provider list, model
  // source, skill catalog OR connector list blocks save even when the skill/connector ref arrays
  // are EMPTY. When refs are present, the referenced batch must also be settled and match exactly.
  const modelReady =
    Boolean(model) && providersUsable && sourceSettled && isModelCurrent(model, source.data);
  const skillsReady =
    skillsSettled && (dependencies.skills.length === 0 || staleSkills.length === 0);
  // A connector selected for add/update means an authoring operation is in flight: its current
  // detail must be a settled, RESOLVED success (not undefined/loading, not retained-data+error,
  // not retained-data+isValidating, and not a null/unresolvable projection). Otherwise save FAILS
  // CLOSED — the operator could otherwise commit while authoring from a stale/absent snapshot. With
  // no connector selected, no current detail is required.
  const connectorDetailReady =
    !connectorId || (connectorDetailUsable && connectorDetail.data != null);
  const connectorsReady =
    connectorsListUsable &&
    connectorDetailReady &&
    (dependencies.connectors.length === 0 || (connectorsSettled && staleConnectors.length === 0));
  const ready = modelReady && skillsReady && connectorsReady;

  const issues = useMemo(() => {
    const list: string[] = [];
    if (displayModelStale) list.push('agentCatalog.dependency.issues.modelStale');
    if (staleSkills.length > 0) list.push('agentCatalog.dependency.issues.skillStale');
    if (staleConnectors.length > 0) list.push('agentCatalog.dependency.issues.connectorStale');
    return list;
  }, [displayModelStale, staleConnectors.length, staleSkills.length]);

  /**
   * Everything that is blocking Save, stated in full: the model that has not been chosen yet, plus
   * the catalog states the caller cannot see (Skills and Connectors are authored inside a collapsed
   * group, so an errored or still-loading catalog would otherwise disable Save silently). Each
   * entry carries the catalog's own retry when it has one.
   */
  const blockers = useMemo<DependencyBlocker[]>(() => {
    const list: DependencyBlocker[] = [];
    const add = (message: string, retry?: () => Promise<unknown>) => {
      if (list.some((blocker) => blocker.message === message)) return;
      list.push(retry ? { message, retry } : { message });
    };

    if (providers.error) add('agentCatalog.dependency.model.loadError', providers.mutate);
    else if (!providersUsable) add('agentCatalog.editor.blocked.providerCatalog');
    // The model is a required member of the dependency snapshot, so an unset one blocks Save just
    // as hard as an unhealthy catalog — and used to do it without a word anywhere in the modal.
    if (!model) add('agentCatalog.editor.blocked.model');

    if (skills.error) add('agentCatalog.dependency.skill.loadError', skills.mutate);
    else if (!skillsSettled) add('agentCatalog.editor.blocked.skillCatalog');

    if (connectors.error) add('agentCatalog.dependency.connector.loadError', connectors.mutate);
    else if (!connectorsListUsable) add('agentCatalog.editor.blocked.connectorCatalog');

    if (connectorRefDetails.error) {
      add('agentCatalog.dependency.connector.validateError', connectorRefDetails.mutate);
    } else if (dependencies.connectors.length > 0 && !connectorsSettled) {
      add('agentCatalog.editor.blocked.connectorCatalog');
    }

    if (connectorId && !connectorDetailReady) {
      if (connectorDetail.error) {
        add('agentCatalog.dependency.connector.loadError', connectorDetail.mutate);
      } else add('agentCatalog.editor.blocked.connectorCatalog');
    }
    return list;
  }, [
    connectorDetail.error,
    connectorDetail.mutate,
    connectorDetailReady,
    connectorId,
    connectorRefDetails.error,
    connectorRefDetails.mutate,
    connectors.error,
    connectors.mutate,
    connectorsListUsable,
    connectorsSettled,
    dependencies.connectors.length,
    model,
    providers.error,
    providers.mutate,
    providersUsable,
    skills.error,
    skills.mutate,
    skillsSettled,
  ]);

  // Retry callbacks are not stable identities, so the publish effect keys off the message list and
  // reads the current blockers through a ref instead of re-firing on every catalog render.
  const blockersRef = useRef(blockers);
  blockersRef.current = blockers;
  const blockersKey = blockers.map((blocker) => blocker.message).join('|');

  const issuesKey = issues.join('|');
  useEffect(() => {
    onValidityChange?.({
      blockers: blockersRef.current,
      issues: issuesKey ? issuesKey.split('|') : [],
      ready,
    });
  }, [blockersKey, issuesKey, onValidityChange, ready]);

  const chooseProvider = (nextId: string | undefined) => {
    if (!providersUsable) return; // never select against a loading/revalidating/errored provider list
    setProviderId(nextId);
    if (dependencies.model) onChange(withModel(dependencies, null));
  };

  const chooseModel = (modelKey: string | undefined) => {
    // Fail closed: never author a model ref from a loading/revalidating/errored source snapshot.
    if (!modelKey || !sourceSettled || !source.data) return;
    onChange(withModel(dependencies, buildModelDependency(source.data, modelKey)));
  };

  const skillOptions = useMemo(
    () =>
      (skills.data ?? [])
        .filter((skill) => !dependencies.skills.some((s) => s.skillKey === skill.skillKey))
        .map((skill) => ({
          label: `${skill.displayName} · ${skill.version}`,
          value: skill.skillKey,
        })),
    [dependencies.skills, skills.data],
  );
  const addSkill = (skillKey: string | undefined) => {
    if (!skillsSettled) return; // never author from a loading/revalidating/errored skill catalog
    const published = skills.data?.find((skill) => skill.skillKey === skillKey);
    if (published) onChange(withSkillAdded(dependencies, buildSkillDependency(published)));
  };

  const connectorOptions = useMemo(
    () =>
      (connectorItems ?? []).map((connector) => ({
        label: `${connector.displayName} (${connector.key})`,
        value: connector.id,
      })),
    [connectorItems],
  );
  const addConnector = () => {
    // Fail closed: never author a connector ref from a loading/revalidating/errored detail snapshot.
    if (!connectorDetailUsable || !connectorDetail.data) return;
    onChange(
      withConnectorAdded(
        dependencies,
        buildConnectorDependency(
          connectorDetail.data,
          allowedConnectorToolKeys(connectorDetail.data),
        ),
      ),
    );
    setConnectorId(undefined);
  };

  const updateExistingConnector = (connectorKey: string) => {
    if (!connectorsListUsable) return;
    const match = connectorItems?.find((option) => option.key === connectorKey);
    if (match) setConnectorId(match.id);
    else setConnectorSearch(connectorKey);
  };

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

  const slots: DependencyEditorSlots = {
    connectors: (
      <ConnectorDependencyField
        connectorDetail={connectorDetail}
        connectorDetailUsable={connectorDetailUsable}
        connectorId={connectorId}
        connectorOptions={connectorOptions}
        connectorRefDetails={connectorRefDetails}
        connectorSearch={connectorSearch}
        connectors={connectorsSlice}
        connectorsListUsable={connectorsListUsable}
        connectorsSettled={connectorsSettled}
        editable={editable}
        enabled={enabled}
        staleConnectors={staleConnectors}
        value={dependencies.connectors}
        onAdd={addConnector}
        onConnectorSearchChange={setConnectorSearch}
        onRemove={(connectorKey) => onChange(withConnectorRemoved(dependencies, connectorKey))}
        onSelectConnector={setConnectorId}
        onUpdateExisting={updateExistingConnector}
      />
    ),
    model: (
      <ModelDependencyField
        // The caller's form section already reads "Model" when it places this slot itself.
        displayModelStale={displayModelStale}
        editable={editable}
        hideTitle={Boolean(children)}
        model={model}
        providerId={providerId}
        providerSearch={providerSearch}
        providers={providersSlice}
        providersUsable={providersUsable}
        source={source}
        sourceSettled={sourceSettled}
        onChooseModel={chooseModel}
        onChooseProvider={chooseProvider}
        onProviderSearchChange={(next) => {
          setProviderSearch(next);
          setProviderHydrateQuery('');
        }}
      />
    ),
    skills: (
      <SkillDependencyField
        editable={editable}
        skillOptions={skillOptions}
        skills={skills}
        skillsSettled={skillsSettled}
        staleSkills={staleSkills}
        value={dependencies.skills}
        onAdd={addSkill}
        onRemove={(skillKey) => onChange(withSkillRemoved(dependencies, skillKey))}
      />
    ),
  };

  if (children) return <>{children(slots)}</>;

  return (
    <Flexbox gap={20}>
      {slots.model}
      {slots.skills}
      {slots.connectors}
    </Flexbox>
  );
};
