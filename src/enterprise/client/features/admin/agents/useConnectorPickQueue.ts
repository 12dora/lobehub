'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  allowedConnectorToolKeys,
  buildConnectorDependency,
  withConnectorAdded,
} from './dependencyCatalog';
import type { AdminAgentDraftDependencies } from './types';
import type { useAdminConnectorDetail } from './useDependencyCatalog';

/** Shared identity for "nothing queued", so an unchanged queue never re-renders the field. */
const NO_PENDING_CONNECTORS: string[] = [];

/**
 * Every connector the admin has picked whose exact detail has not been authored yet, in pick
 * order — tagged with the Agent that picked them. A second pick made while the first is still
 * resolving must NOT replace it: both stay queued, both stay in the picker's value, and both keep
 * Save closed until they settle.
 */
export const useConnectorPickQueue = (agentId: string) => {
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

  const clearQueue = useCallback(
    () => setPendingConnectors({ agentId, ids: NO_PENDING_CONNECTORS }),
    [agentId],
  );

  return {
    clearQueue,
    // Details are resolved one at a time: the head of the queue is the only id being fetched.
    connectorId: pendingConnectorIds[0],
    /** The Agent that owns the queue as stored — not necessarily the one now being edited. */
    ownerAgentId: pendingConnectors.agentId,
    pendingConnectorIds,
    updatePendingConnectorIds,
  };
};

export type ConnectorPickQueue = ReturnType<typeof useConnectorPickQueue>;

/**
 * Author the queued connectors from their EXACT published detail, and only from a settled,
 * resolved snapshot of the queued id — never from a loading, revalidating, errored, unpublished
 * or previously fetched one. The authored id leaves the queue so the next pick resolves next.
 */
export const useAuthorQueuedConnector = ({
  agentId,
  connectorDetail,
  connectorDetailUsableForHead,
  connectorId,
  dependencies,
  onChange,
  ownerAgentId,
  updatePendingConnectorIds,
}: {
  agentId: string;
  connectorDetail: ReturnType<typeof useAdminConnectorDetail>;
  connectorDetailUsableForHead: boolean;
  connectorId: string | undefined;
  dependencies: AdminAgentDraftDependencies;
  onChange: (next: AdminAgentDraftDependencies) => void;
  ownerAgentId: string;
  updatePendingConnectorIds: (update: (current: string[]) => string[]) => void;
}) => {
  const authoredConnectorRef = useRef<{ agentId: string; connectorId: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    // No head means either an empty queue or a queue belonging to another Agent — in both cases
    // there is nothing this Agent may author, and the authored marker must not outlive the context.
    if (!connectorId || ownerAgentId !== agentId) {
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
    ownerAgentId,
    updatePendingConnectorIds,
  ]);
};
