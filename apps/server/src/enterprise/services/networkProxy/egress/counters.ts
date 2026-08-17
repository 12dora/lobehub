import type { EgressScopeId } from '@/const/platform/networkProxy';

const proxied: Record<string, number> = Object.create(null);
const fallback: Record<string, number> = Object.create(null);
const fallbackWarned = new Set<string>();

const bump = (bag: Record<string, number>, scope: EgressScopeId): number => {
  const next = (bag[scope] ?? 0) + 1;
  bag[scope] = next;
  return next;
};

export const incrementProxied = (scope: EgressScopeId): number => bump(proxied, scope);

export const incrementFallback = (scope: EgressScopeId): number => bump(fallback, scope);

export const consumeFallbackFirstWarn = (scope: EgressScopeId): boolean => {
  if (fallbackWarned.has(scope)) return false;
  fallbackWarned.add(scope);
  return true;
};

export const getEgressCounters = (): {
  fallback: Record<string, number>;
  fallbackScopes: EgressScopeId[];
  proxied: Record<string, number>;
} => ({
  fallback: { ...fallback },
  fallbackScopes: Object.keys(fallback).filter(
    (key) => (fallback[key] ?? 0) > 0,
  ) as EgressScopeId[],
  proxied: { ...proxied },
});

export const resetEgressCountersForTest = (): void => {
  for (const key of Object.keys(proxied)) delete proxied[key];
  for (const key of Object.keys(fallback)) delete fallback[key];
  fallbackWarned.clear();
};
