/**
 * Self-reconciling registry for managed-local-agent guards (SG-02).
 *
 * Expected coverage is derived from **live routers**, not from the guard:
 * every mutation under agent / agentGroup / home / agentDocument must be either
 * in {@link MANAGED_LOCAL_AGENT_GUARDED_MUTATIONS} or in the explicit unguarded
 * allowlist. A newly added mutation fails until someone classifies it.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import { authedProcedure, router } from '@/libs/trpc/lambda';
import { agentRouter } from '@/server/routers/lambda/agent';
import { agentDocumentRouter } from '@/server/routers/lambda/agentDocument';
import { agentGroupRouter } from '@/server/routers/lambda/agentGroup';
import { homeRouter } from '@/server/routers/lambda/home';

import {
  getManagedLocalAgentGuardMetadata,
  MANAGED_LOCAL_AGENT_GUARDED_MUTATIONS,
  pickAgentId,
  procedureHasManagedLocalAgentGuard,
  withManagedLocalAgentGuard,
} from './managedPlatformAgent';

type ProcedureRecord = Record<string, unknown>;

/**
 * Mutations that intentionally omit {@link withManagedLocalAgentGuard}.
 * Group-scoped writes take no agent id; create paths mint a new agent rather
 * than mutating an existing materialized local id; getOrCreateChatTopic is a
 * read-side convenience mutation on the non-write procedure chain.
 *
 * Any other unguarded mutation must be added here deliberately (with a comment)
 * or the registry test fails.
 */
const EXPLICITLY_UNGUARDED_MUTATIONS = Object.freeze([
  // Creates a new local agent — no pre-existing agent id to guard.
  'agent.createAgent',
  'agent.createAgentOnly',
  // Group-scoped writes (no agent id / only create new member agents).
  'agentGroup.batchCreateAgentsInGroup',
  'agentGroup.createGroup',
  'agentGroup.createGroupWithMembers',
  'agentGroup.deleteGroup',
  'agentGroup.duplicateGroup',
  'agentGroup.transferGroup',
  'agentGroup.publishGroupToWorkspace',
  'agentGroup.updateGroup',
  'agentGroup.acquireGroupLock',
  'agentGroup.releaseGroupLock',
  // Read-procedure mutation (agentDocumentProcedure, not Write).
  'agentDocument.getOrCreateChatTopic',
] as const);

const MANAGED_LOCAL_AGENT_ROUTER_PREFIXES = [
  'agent',
  'agentGroup',
  'home',
  'agentDocument',
] as const;

/** Collect every mutation path under the managed-local-agent routers (guard or not). */
export const collectLiveMutationPaths = (
  routers: Array<{ prefix: string; procedures: ProcedureRecord }>,
): string[] => {
  const paths: string[] = [];
  for (const { prefix, procedures } of routers) {
    for (const [name, procedure] of Object.entries(procedures)) {
      const def = (procedure as { _def?: { type?: unknown } })._def;
      if (def?.type !== 'mutation') continue;
      paths.push(`${prefix}.${name}`);
    }
  }
  return paths.sort();
};

/** Collect mutation paths that currently carry managed-local-agent middleware metadata. */
export const collectLiveGuardedPaths = (
  routers: Array<{ prefix: string; procedures: ProcedureRecord }>,
): string[] => {
  const paths: string[] = [];
  for (const { prefix, procedures } of routers) {
    for (const [name, procedure] of Object.entries(procedures)) {
      const def = (procedure as { _def?: { type?: unknown } })._def;
      if (def?.type !== 'mutation') continue;
      if (!procedureHasManagedLocalAgentGuard(procedure)) continue;
      paths.push(`${prefix}.${name}`);
    }
  }
  return paths.sort();
};

export interface ManagedLocalAgentGuardReconcileResult {
  /** Live guarded mutations missing from the inventory. */
  missingFromInventory: string[];
  /** Inventory entries that claim a guard the live procedure does not carry. */
  staleInInventory: string[];
  /** Allowlist entries that are not live mutations (stale allowlist). */
  staleUnguarded: string[];
  /** Live mutations present in neither the guarded inventory nor the unguarded allowlist. */
  unclassified: string[];
}

/**
 * Pure reconciler: every live mutation must be classified, inventory must match
 * live guards, and the unguarded allowlist must not go stale.
 */
export const reconcileManagedLocalAgentGuardCoverage = (params: {
  everyMutation: readonly string[];
  guardedInventory: readonly string[];
  explicitlyUnguarded: readonly string[];
  liveGuarded: readonly string[];
}): ManagedLocalAgentGuardReconcileResult => {
  const inventory = new Set(params.guardedInventory);
  const unguarded = new Set(params.explicitlyUnguarded);
  const liveGuarded = new Set(params.liveGuarded);
  const every = new Set(params.everyMutation);

  const classified = new Set([...inventory, ...unguarded]);
  const unclassified = [...every].filter((path) => !classified.has(path)).sort();
  const staleInInventory = [...inventory].filter((path) => !liveGuarded.has(path)).sort();
  const missingFromInventory = [...liveGuarded].filter((path) => !inventory.has(path)).sort();
  const staleUnguarded = [...unguarded].filter((path) => !every.has(path)).sort();

  return { missingFromInventory, staleInInventory, staleUnguarded, unclassified };
};

const productionRouters = (): Array<{ prefix: string; procedures: ProcedureRecord }> => [
  { prefix: 'agent', procedures: agentRouter._def.procedures as ProcedureRecord },
  { prefix: 'agentGroup', procedures: agentGroupRouter._def.procedures as ProcedureRecord },
  { prefix: 'home', procedures: homeRouter._def.procedures as ProcedureRecord },
  {
    prefix: 'agentDocument',
    procedures: agentDocumentRouter._def.procedures as ProcedureRecord,
  },
];

describe('managed local agent guard registry', () => {
  it('classifies every live mutation as guarded inventory or explicit unguarded', () => {
    const routers = productionRouters();
    const everyMutation = collectLiveMutationPaths(routers);
    const liveGuarded = collectLiveGuardedPaths(routers);

    expect(everyMutation.length).toBeGreaterThan(0);
    expect(
      MANAGED_LOCAL_AGENT_ROUTER_PREFIXES.every((prefix) =>
        everyMutation.some((path) => path.startsWith(`${prefix}.`)),
      ),
    ).toBe(true);

    const result = reconcileManagedLocalAgentGuardCoverage({
      everyMutation,
      explicitlyUnguarded: EXPLICITLY_UNGUARDED_MUTATIONS,
      guardedInventory: MANAGED_LOCAL_AGENT_GUARDED_MUTATIONS,
      liveGuarded,
    });

    expect(result).toEqual({
      missingFromInventory: [],
      staleInInventory: [],
      staleUnguarded: [],
      unclassified: [],
    });
  });

  it('attaches frozen non-enumerable metadata with the picker kind', () => {
    const procedure = authedProcedure
      .use(withManagedLocalAgentGuard(pickAgentId))
      .mutation(() => null);

    const metadata = getManagedLocalAgentGuardMetadata(procedure);
    expect(metadata).toEqual([{ kind: 'managedLocalAgent', picker: 'agentId' }]);
    expect(Object.isFrozen(metadata[0])).toBe(true);

    // tRPC procedures are callable, so `typeof` is 'function', not 'object'.
    const procedureDef =
      (typeof procedure === 'object' || typeof procedure === 'function') &&
      procedure !== null &&
      '_def' in procedure &&
      typeof (procedure as { _def: unknown })._def === 'object' &&
      (procedure as { _def: unknown })._def !== null
        ? (procedure as { _def: { middlewares?: readonly unknown[] } })._def
        : null;
    const middlewares = procedureDef?.middlewares ?? [];
    const guarded = middlewares.find((middleware) => {
      const carrier = Object.assign(() => undefined, { _def: { middlewares: [middleware] } });
      return getManagedLocalAgentGuardMetadata(carrier).length === 1;
    });
    expect(guarded).toBeTruthy();
    const [symbol] = Object.getOwnPropertySymbols(guarded!);
    expect(Object.getOwnPropertyDescriptor(guarded!, symbol!)?.enumerable).toBe(false);
  });

  it('reconciler reports unclassified when a live mutation is neither inventoried nor allowlisted', () => {
    const throwaway = router({
      guardedWrite: authedProcedure
        .use(withManagedLocalAgentGuard(pickAgentId))
        .mutation(() => null),
      // Simulates "add a new agent mutation without the guard".
      forgottenWrite: authedProcedure.mutation(() => null),
    });

    const routers = [{ prefix: 'probe', procedures: throwaway._def.procedures as ProcedureRecord }];
    const everyMutation = collectLiveMutationPaths(routers);
    const liveGuarded = collectLiveGuardedPaths(routers);

    const result = reconcileManagedLocalAgentGuardCoverage({
      everyMutation,
      explicitlyUnguarded: [],
      guardedInventory: ['probe.guardedWrite'],
      liveGuarded,
    });

    expect(result.unclassified).toEqual(['probe.forgottenWrite']);
    expect(result.missingFromInventory).toEqual([]);
    expect(result.staleInInventory).toEqual([]);
  });

  it('reconciler reports stale inventory when an inventoried mutation lacks the middleware', () => {
    const throwaway = router({
      claimedGuarded: authedProcedure.mutation(() => null),
    });

    const routers = [{ prefix: 'probe', procedures: throwaway._def.procedures as ProcedureRecord }];
    const everyMutation = collectLiveMutationPaths(routers);
    const liveGuarded = collectLiveGuardedPaths(routers);

    const result = reconcileManagedLocalAgentGuardCoverage({
      everyMutation,
      explicitlyUnguarded: ['probe.claimedGuarded'],
      guardedInventory: ['probe.claimedGuarded'],
      liveGuarded,
    });

    // Present in inventory but not actually guarded → staleInInventory.
    // Also listed as explicitly unguarded so it is not "unclassified".
    expect(result.staleInInventory).toEqual(['probe.claimedGuarded']);
    expect(liveGuarded).toEqual([]);
    expect(procedureHasManagedLocalAgentGuard(throwaway._def.procedures.claimedGuarded)).toBe(
      false,
    );
  });
});
