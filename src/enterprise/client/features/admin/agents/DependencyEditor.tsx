'use client';

import { Flexbox } from '@lobehub/ui';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

/** Shared identity for "nothing queued", so an unchanged queue never re-renders the field. */
const NO_PENDING_CONNECTORS: string[] = [];

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
  /**
   * Every connector the admin has picked whose exact detail has not been authored yet, in pick
   * order — tagged with the Agent that picked them. A second pick made while the first is still
   * resolving must NOT replace it: both stay queued, both stay in the picker's value, and both keep
   * Save closed until they settle.
   */
  const [pendingConnectors, setPendingConnectors] = useState<{ agentId: string; ids: string[] }>(
    () => ({ agentId, ids: NO_PENDING_CONNECTORS }),
  );
  /**
   * A queue picked under a different Agent is not ours, and it is empty from THIS render on — an
   * effect-time reset would still leave the previous Agent's head in flight during the render that
   * already carries the new Agent's `dependencies`, and authoring it would cross the two drafts.
   */
  const pendingConnectorIds =
    pendingConnectors.agentId === agentId ? pendingConnectors.ids : NO_PENDING_CONNECTORS;
  // Details are resolved one at a time: the head of the queue is the only id being fetched.
  const connectorId = pendingConnectorIds[0];

  /** Queue writes always re-stamp the owning Agent, so a write can never adopt a foreign queue. */
  const updatePendingConnectorIds = useCallback(
    (update: (current: string[]) => string[]) => {
      setPendingConnectors((current) => {
        const owned = current.agentId === agentId ? current.ids : NO_PENDING_CONNECTORS;
        const ids = update(owned);
        if (current.agentId === agentId && ids === owned) return current;
        return { agentId, ids };
      });
    },
    [agentId],
  );

  // Reset all selection state whenever the Agent context changes — never bleed across Agents.
  const agentRef = useRef(agentId);
  useEffect(() => {
    if (agentRef.current === agentId) return;
    agentRef.current = agentId;
    setProviderId(undefined);
    setPendingConnectors({ agentId, ids: NO_PENDING_CONNECTORS });
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
  // The head's detail must be a settled, RESOLVED success (not undefined/loading, not
  // retained-data+error, not retained-data+isValidating, and not a null/unresolvable projection)
  // AND must describe the queue head rather than a previously fetched connector before anything is
  // authored from it. This gates AUTHORING only — see `connectorsReady` for what gates Save.
  const connectorDetailUsableForHead =
    Boolean(connectorId) &&
    connectorDetailUsable &&
    connectorDetail.data?.connectorId === connectorId;
  // Save FAILS CLOSED for as long as ANYTHING is queued — a usable head detail says only that the
  // head can be authored now, not that the picks behind it have landed, so gating on it would open
  // Save for the render between the head settling and the next pick becoming the head, letting a
  // snapshot commit without the later picks. Once the queue drains, the freshly authored refs still
  // have to pass the referenced batch below (its SWR key changed, so it is unsettled again).
  const connectorsReady =
    connectorsListUsable &&
    pendingConnectorIds.length === 0 &&
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

    // Anything still queued blocks Save, so it must be stated — including the render in which the
    // head is already authorable but the picks behind it are not.
    if (pendingConnectorIds.length > 0) {
      if (connectorDetail.error) {
        add('agentCatalog.dependency.connector.loadError', connectorDetail.mutate);
      } else add('agentCatalog.editor.blocked.connectorCatalog');
    }
    return list;
  }, [
    connectorDetail.error,
    connectorDetail.mutate,
    connectorRefDetails.error,
    connectorRefDetails.mutate,
    connectors.error,
    connectors.mutate,
    connectorsListUsable,
    connectorsSettled,
    dependencies.connectors.length,
    model,
    pendingConnectorIds.length,
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

  // Every published Skill, plus the referenced ones the catalog no longer offers: a ref that is
  // missing from the picker could never be unpicked, and it blocks Save.
  const skillOptions = useMemo(() => {
    const published = skills.data ?? [];
    const options = published.map((skill) => ({
      label: `${skill.displayName} · ${skill.version}`,
      value: skill.skillKey,
    }));
    for (const ref of dependencies.skills) {
      if (published.some((skill) => skill.skillKey === ref.skillKey)) continue;
      options.push({ label: `${ref.skillKey} · ${ref.version}`, value: ref.skillKey });
    }
    return options;
  }, [dependencies.skills, skills.data]);

  const setSkills = (skillKeys: string[]) => {
    if (!skillsSettled) return; // never author from a loading/revalidating/errored skill catalog
    let next = dependencies;
    for (const ref of dependencies.skills) {
      if (!skillKeys.includes(ref.skillKey)) next = withSkillRemoved(next, ref.skillKey);
    }
    for (const skillKey of skillKeys) {
      if (dependencies.skills.some((ref) => ref.skillKey === skillKey)) continue;
      const published = skills.data?.find((skill) => skill.skillKey === skillKey);
      if (published) next = withSkillAdded(next, buildSkillDependency(published));
    }
    if (next !== dependencies) onChange(next);
  };

  const connectorOptions = useMemo(() => {
    const items = connectorItems ?? [];
    const options = items.map((connector) => ({
      label: `${connector.displayName} (${connector.key})`,
      value: connector.id,
    }));
    for (const ref of dependencies.connectors) {
      if (items.some((connector) => connector.id === ref.connectorId)) continue;
      options.push({ label: ref.connectorKey, value: ref.connectorId });
    }
    return options;
  }, [connectorItems, dependencies.connectors]);

  const setConnectors = (connectorIds: string[]) => {
    if (!connectorsListUsable) return; // never author against a stale/errored/revalidating list
    let next = dependencies;
    for (const ref of dependencies.connectors) {
      if (!connectorIds.includes(ref.connectorId))
        next = withConnectorRemoved(next, ref.connectorKey);
    }
    if (next !== dependencies) onChange(next);
    // A pick only becomes a dependency once its exact detail settles (see the effect below); until
    // then it is queued here so the picker can show it and the readiness predicate can block Save.
    // Unpicking a still-pending id cancels it, so a queued pick can always be taken back.
    updatePendingConnectorIds((current) => {
      const kept = current.filter((id) => connectorIds.includes(id));
      const added = connectorIds.filter(
        (id) =>
          !kept.includes(id) && !dependencies.connectors.some((ref) => ref.connectorId === id),
      );
      const merged = [...kept, ...added];
      const unchanged =
        merged.length === current.length && merged.every((id, index) => id === current[index]);
      return unchanged ? current : merged;
    });
  };

  /**
   * Dropping a connector row is ONE operation: the authored reference goes, and so does any queued
   * add/update for the same connector. Otherwise an Update clicked before its detail settles would
   * land afterwards and silently resurrect the row the admin just removed.
   */
  const removeConnector = (connectorKey: string) => {
    const ref = dependencies.connectors.find((entry) => entry.connectorKey === connectorKey);
    if (!ref) return;
    onChange(withConnectorRemoved(dependencies, connectorKey));
    updatePendingConnectorIds((current) =>
      current.includes(ref.connectorId) ? current.filter((id) => id !== ref.connectorId) : current,
    );
  };

  // Author the queued connectors from their EXACT published detail, and only from a settled,
  // resolved snapshot of the queued id — never from a loading, revalidating, errored, unpublished
  // or previously fetched one. The authored id leaves the queue so the next pick resolves next.
  const authoredConnectorRef = useRef<{ agentId: string; connectorId: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    // No head means either an empty queue or a queue belonging to another Agent — in both cases
    // there is nothing this Agent may author, and the authored marker must not outlive the context.
    if (!connectorId || pendingConnectors.agentId !== agentId) {
      authoredConnectorRef.current = undefined;
      return;
    }
    const authored = authoredConnectorRef.current;
    if (authored?.agentId === agentId && authored.connectorId === connectorId) return;
    const detail = connectorDetail.data;
    if (!connectorDetailUsableForHead || !detail) return;
    authoredConnectorRef.current = { agentId, connectorId };
    onChange(
      withConnectorAdded(
        dependencies,
        buildConnectorDependency(detail, allowedConnectorToolKeys(detail)),
      ),
    );
    updatePendingConnectorIds((current) => current.filter((id) => id !== connectorId));
  }, [
    agentId,
    connectorDetail.data,
    connectorDetailUsableForHead,
    connectorId,
    dependencies,
    onChange,
    pendingConnectors.agentId,
    updatePendingConnectorIds,
  ]);

  const updateExistingConnector = (connectorKey: string) => {
    if (!connectorsListUsable) return;
    const match = connectorItems?.find((option) => option.key === connectorKey);
    if (!match) {
      setConnectorSearch(connectorKey);
      return;
    }
    updatePendingConnectorIds((current) =>
      current.includes(match.id) ? current : [...current, match.id],
    );
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
        connectorOptions={connectorOptions}
        connectorRefDetails={connectorRefDetails}
        connectorSearch={connectorSearch}
        connectors={connectorsSlice}
        connectorsListUsable={connectorsListUsable}
        connectorsSettled={connectorsSettled}
        editable={editable}
        enabled={enabled}
        pendingConnectorIds={pendingConnectorIds}
        staleConnectors={staleConnectors}
        value={dependencies.connectors}
        onChange={setConnectors}
        onConnectorSearchChange={setConnectorSearch}
        onRemove={removeConnector}
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
        onChange={setSkills}
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
