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
  withConnectorAdded,
  withConnectorRemoved,
  withModel,
  withSkillAdded,
  withSkillRemoved,
} from './dependencyCatalog';
import type { DependencyValidity } from './dependencyEditorTypes';
import { ModelDependencyField } from './ModelDependencyField';
import { SkillDependencyField } from './SkillDependencyField';
import type { AdminAgentDraftDependencies } from './types';
import { useDependencyCatalogs } from './useDependencyCatalogs';
import { useDependencyReadiness } from './useDependencyReadiness';

export type { DependencyBlocker, DependencyValidity } from './dependencyEditorTypes';

/** Shared identity for "nothing queued", so an unchanged queue never re-renders the field. */
const NO_PENDING_CONNECTORS: string[] = [];

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

  const {
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
  } = useDependencyCatalogs({ connectorId, dependencies, enabled });

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selection reset is keyed only on Agent identity
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters are stable; deps match HEAD
  }, [dependencies.model, providerHydrateQuery, providerId, providerItems]);

  const { connectorDetailUsableForHead, displayModelStale, staleConnectors, staleSkills } =
    useDependencyReadiness({
      connectorDetail,
      connectorDetailUsable,
      connectorId,
      connectorRefDetails,
      connectors,
      connectorsListUsable,
      connectorsSettled,
      dependencies,
      onValidityChange,
      pendingConnectorIds,
      providers,
      providersUsable,
      skills,
      skillsSettled,
      source,
      sourceSettled,
    });

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
