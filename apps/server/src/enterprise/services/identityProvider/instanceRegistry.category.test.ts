// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { identityProviderDegradedCategory } from './instanceRegistry';
import type { IdentityProviderStartupSnapshot } from './startupArtifact';

const snapshot = (
  overrides: Partial<IdentityProviderStartupSnapshot> = {},
): IdentityProviderStartupSnapshot => ({
  databaseProviders: [],
  generation: null,
  health: 'degraded',
  identityRevision: null,
  lastError: null,
  loadedAt: new Date(),
  providerIds: [],
  source: 'break_glass',
  ...overrides,
});

describe('identityProviderDegradedCategory', () => {
  it('does not invent break_glass_fallback for process-init lastError', () => {
    expect(
      identityProviderDegradedCategory(snapshot({ lastError: 'startup_snapshot_not_initialized' })),
    ).toBe('startup_snapshot_unavailable');
    expect(
      identityProviderDegradedCategory(snapshot({ lastError: 'startup_snapshot_loading' })),
    ).toBe('startup_snapshot_unavailable');
  });

  it('prefers secret_unavailable over break_glass_fallback', () => {
    expect(identityProviderDegradedCategory(snapshot({ lastError: 'secret_unavailable' }))).toBe(
      'secret_unavailable',
    );
  });

  it('uses break_glass_fallback only when published material failed to load', () => {
    expect(
      identityProviderDegradedCategory(snapshot({ lastError: 'startup_snapshot_unavailable' })),
    ).toBe('break_glass_fallback');
  });

  it('keeps lkg as lkg_fallback', () => {
    expect(
      identityProviderDegradedCategory(
        snapshot({ lastError: 'startup_snapshot_unavailable', source: 'lkg' }),
      ),
    ).toBe('lkg_fallback');
  });

  it('returns null when healthy', () => {
    expect(identityProviderDegradedCategory(snapshot({ health: 'healthy', lastError: null }))).toBe(
      null,
    );
  });
});
