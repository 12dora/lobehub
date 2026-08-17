'use client';

import { useEffect, useMemo, useRef } from 'react';

import { isModelCurrent, staleConnectorKeys, staleSkillKeys } from './dependencyCatalog';
import type { DependencyBlocker, DependencyValidity } from './dependencyEditorTypes';
import type { AdminAgentDraftDependencies } from './types';
import type {
  useAdminConnectorDetail,
  useAdminConnectorDetails,
  useAdminProviderModelSource,
  useAdminPublishedConnectors,
  useAdminPublishedProviders,
  useAdminPublishedSkills,
} from './useDependencyCatalog';

interface UseDependencyReadinessParams {
  connectorDetail: ReturnType<typeof useAdminConnectorDetail>;
  connectorDetailUsable: boolean;
  connectorId: string | undefined;
  connectorRefDetails: ReturnType<typeof useAdminConnectorDetails>;
  connectors: ReturnType<typeof useAdminPublishedConnectors>;
  connectorsListUsable: boolean;
  connectorsSettled: boolean;
  dependencies: AdminAgentDraftDependencies;
  onValidityChange?: (validity: DependencyValidity) => void;
  pendingConnectorIds: string[];
  providers: ReturnType<typeof useAdminPublishedProviders>;
  providersUsable: boolean;
  skills: ReturnType<typeof useAdminPublishedSkills>;
  skillsSettled: boolean;
  source: ReturnType<typeof useAdminProviderModelSource>;
  sourceSettled: boolean;
}

export const useDependencyReadiness = ({
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
}: UseDependencyReadinessParams) => {
  const model = dependencies.model;

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

  return {
    connectorDetailUsableForHead,
    displayModelStale,
    staleConnectors,
    staleSkills,
  };
};
