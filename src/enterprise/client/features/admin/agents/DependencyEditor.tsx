'use client';

import { Flexbox } from '@lobehub/ui';
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

export interface DependencyValidity {
  issues: string[];
  ready: boolean;
}

interface DependencyEditorProps {
  /** Owning Agent id — changing it resets the provider/connector selection so it never bleeds. */
  agentId: string;
  dependencies: AdminAgentDraftDependencies;
  editable: boolean;
  enabled: boolean;
  onChange: (next: AdminAgentDraftDependencies) => void;
  onValidityChange?: (validity: DependencyValidity) => void;
}

export const DependencyEditor = ({
  agentId,
  dependencies,
  editable,
  enabled,
  onChange,
  onValidityChange,
}: DependencyEditorProps) => {
  const providers = useAdminPublishedProviders(enabled);
  const skills = useAdminPublishedSkills(enabled);
  const connectors = useAdminPublishedConnectors(enabled);

  const [providerId, setProviderId] = useState<string | undefined>();
  const [connectorId, setConnectorId] = useState<string | undefined>();

  // Reset all selection state whenever the Agent context changes — never bleed across Agents.
  const agentRef = useRef(agentId);
  useEffect(() => {
    if (agentRef.current === agentId) return;
    agentRef.current = agentId;
    setProviderId(undefined);
    setConnectorId(undefined);
  }, [agentId]);

  // Initialise the provider selection from an existing model ref (edit / recovery).
  useEffect(() => {
    if (providerId || !dependencies.model || !providers.data) return;
    const match = providers.data.find(
      (provider) => provider.providerKey === dependencies.model!.providerKey,
    );
    if (match) setProviderId(match.id);
  }, [dependencies.model, providerId, providers.data]);

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

  const issuesKey = issues.join('|');
  useEffect(() => {
    onValidityChange?.({ issues: issuesKey ? issuesKey.split('|') : [], ready });
  }, [issuesKey, onValidityChange, ready]);

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
      (connectors.data ?? []).map((connector) => ({
        label: `${connector.displayName} (${connector.key})`,
        value: connector.id,
      })),
    [connectors.data],
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
    const match = connectors.data?.find((option) => option.key === connectorKey);
    if (match) setConnectorId(match.id);
  };

  return (
    <Flexbox gap={20}>
      <ModelDependencyField
        displayModelStale={displayModelStale}
        editable={editable}
        model={model}
        providerId={providerId}
        providers={providers}
        providersUsable={providersUsable}
        source={source}
        sourceSettled={sourceSettled}
        onChooseModel={chooseModel}
        onChooseProvider={chooseProvider}
      />
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
      <ConnectorDependencyField
        connectorDetail={connectorDetail}
        connectorDetailUsable={connectorDetailUsable}
        connectorId={connectorId}
        connectorOptions={connectorOptions}
        connectorRefDetails={connectorRefDetails}
        connectors={connectors}
        connectorsListUsable={connectorsListUsable}
        connectorsSettled={connectorsSettled}
        editable={editable}
        enabled={enabled}
        staleConnectors={staleConnectors}
        value={dependencies.connectors}
        onAdd={addConnector}
        onRemove={(connectorKey) => onChange(withConnectorRemoved(dependencies, connectorKey))}
        onSelectConnector={setConnectorId}
        onUpdateExisting={updateExistingConnector}
      />
    </Flexbox>
  );
};
