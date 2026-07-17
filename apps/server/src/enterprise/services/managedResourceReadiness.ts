import {
  MANAGED_RESOURCE_KINDS,
  type ManagedResourceKind,
} from '@/const/platform/managedResources';
import type { ManagedResourceReadinessMap } from '@/types/platform/managedResources';

export type ManagedResourceReadinessProbe = () => boolean | Promise<boolean>;

const probes = new Map<ManagedResourceKind, ManagedResourceReadinessProbe>();

/** M07–M10 register their published-catalog probes during server bootstrap. */
export const registerManagedResourceReadiness = (
  resource: ManagedResourceKind,
  probe: ManagedResourceReadinessProbe,
): (() => void) => {
  probes.set(resource, probe);
  return () => {
    if (probes.get(resource) === probe) probes.delete(resource);
  };
};

export const resolveManagedResourceReadiness = async (): Promise<ManagedResourceReadinessMap> => {
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

export const clearManagedResourceReadinessForTest = (): void => probes.clear();

export const hasManagedResourceReadinessProbeForTest = (resource: ManagedResourceKind): boolean =>
  probes.has(resource);
