import {
  MANAGED_RESOURCE_KINDS,
  type ManagedResourceKind,
} from '@/const/platform/managedResources';
import type { ManagedResourceReadinessMap } from '@/types/platform/managedResources';

export type ManagedResourceReadinessProbe = () => boolean | Promise<boolean>;

// Process-wide registry + resolve-path ensure latch. Next.js standalone
// evaluates `instrumentation.ts` and route handlers as two module graphs;
// a module-level Map/promise is invisible to the other copy.
export const MANAGED_RESOURCE_READINESS_GLOBAL_KEY = Symbol.for(
  '__lobe_managed_resource_readiness__',
);

/** Sibling latch for `readinessProbes.ts` (must not share the resolve-path inflight). */
export const MANAGED_RESOURCE_READINESS_REGISTER_GLOBAL_KEY = Symbol.for(
  '__lobe_managed_resource_readiness_register__',
);

export interface ManagedResourceReadinessProcessState {
  ensureDone: boolean;
  ensureInFlight: Promise<void> | null;
  probes: Map<ManagedResourceKind, ManagedResourceReadinessProbe>;
}

export interface ManagedResourceReadinessRegisterState {
  done: boolean;
  inflight: Promise<void> | null;
}

type ReadinessGlobal = {
  [MANAGED_RESOURCE_READINESS_GLOBAL_KEY]?: ManagedResourceReadinessProcessState;
  [MANAGED_RESOURCE_READINESS_REGISTER_GLOBAL_KEY]?: ManagedResourceReadinessRegisterState;
};

const readinessGlobal = globalThis as unknown as ReadinessGlobal;

const createProcessState = (): ManagedResourceReadinessProcessState => ({
  ensureDone: false,
  ensureInFlight: null,
  probes: new Map(),
});

const getProcessState = (): ManagedResourceReadinessProcessState =>
  (readinessGlobal[MANAGED_RESOURCE_READINESS_GLOBAL_KEY] ??= createProcessState());

export const getManagedResourceReadinessRegisterState = (): ManagedResourceReadinessRegisterState =>
  (readinessGlobal[MANAGED_RESOURCE_READINESS_REGISTER_GLOBAL_KEY] ??= {
    done: false,
    inflight: null,
  });

const getProbes = (): Map<ManagedResourceKind, ManagedResourceReadinessProbe> =>
  getProcessState().probes;

const ensureProbesIfMissing = async (): Promise<void> => {
  const state = getProcessState();
  if (state.ensureDone) return;
  if (MANAGED_RESOURCE_KINDS.every((kind) => state.probes.has(kind))) return;
  // Dynamic import only: `runtimeReadiness.ts` files import this module.
  state.ensureInFlight ??= import('../bootstrap/readinessProbes')
    .then(({ ensureManagedResourceReadinessProbes }) => ensureManagedResourceReadinessProbes())
    .then(() => {
      state.ensureDone = true;
    })
    .catch((error: unknown) => {
      console.error('[managed-resource-readiness] probe registration failed', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
      });
    })
    .finally(() => {
      state.ensureInFlight = null;
    });
  await state.ensureInFlight;
};

/** M07–M10 register their published-catalog probes during server bootstrap. */
export const registerManagedResourceReadiness = (
  resource: ManagedResourceKind,
  probe: ManagedResourceReadinessProbe,
): (() => void) => {
  const probes = getProbes();
  probes.set(resource, probe);
  return () => {
    if (probes.get(resource) === probe) probes.delete(resource);
  };
};

export const resolveManagedResourceReadiness = async (): Promise<ManagedResourceReadinessMap> => {
  await ensureProbesIfMissing();
  const probes = getProbes();
  const result = {} as ManagedResourceReadinessMap;
  await Promise.all(
    MANAGED_RESOURCE_KINDS.map(async (resource) => {
      const probe = probes.get(resource);
      if (!probe) {
        result[resource] = false;
        return;
      }
      try {
        result[resource] = (await probe()) === true;
      } catch (error) {
        console.error('[managed-resource-readiness] probe failed', { error, resource });
        result[resource] = false;
      }
    }),
  );
  return result;
};

export const clearManagedResourceReadinessForTest = (): void => {
  const state = getProcessState();
  state.probes.clear();
  state.ensureDone = false;
  state.ensureInFlight = null;
  const register = readinessGlobal[MANAGED_RESOURCE_READINESS_REGISTER_GLOBAL_KEY];
  if (register) {
    register.done = false;
    register.inflight = null;
  }
};

export const hasManagedResourceReadinessProbeForTest = (resource: ManagedResourceKind): boolean =>
  getProbes().has(resource);
