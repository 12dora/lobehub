/**
 * Test-only helpers for platform capability / public-snapshot assertions.
 * Not part of the production enterprise service surface.
 */
import { PLATFORM_CAPABILITIES_FORBIDDEN_KEYS } from '@/types/platform/capabilities';

/**
 * Runtime assertion helper for tests / redaction guards.
 * Returns forbidden key paths found in a payload (case-insensitive leaf names).
 */
export const findForbiddenCapabilityKeys = (payload: unknown): string[] => {
  const found: string[] = [];

  const walk = (value: unknown, path: string) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      const lower = key.toLowerCase();
      if (
        PLATFORM_CAPABILITIES_FORBIDDEN_KEYS.some((forbidden) => lower === forbidden.toLowerCase())
      ) {
        found.push(nextPath);
      }
      walk(child, nextPath);
    }
  };

  walk(payload, '');
  return found;
};
