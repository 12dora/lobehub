import { describe, expect, it } from 'vitest';

import {
  PLATFORM_CONVERGENCE_DOMAINS,
  platformDomainTargetSchema,
  platformInstanceStatusSnapshotSchema,
  platformRevisionTokenSchema,
} from './platformInstanceStatus';

const zeroCounts = {
  degraded: 0,
  diverged: 0,
  fresh: 0,
  matching: 0,
  stale: 0,
  unreported: 0,
};

const domainSnapshot = PLATFORM_CONVERGENCE_DOMAINS.map((domain) => ({
  counts: zeroCounts,
  domain,
  errorCategory: null,
  fallbackPolicy: domain === 'identity' ? ('lkg_then_break_glass' as const) : ('none' as const),
  loadMode:
    domain === 'identity'
      ? ('restart_activated' as const)
      : domain === 'agent_catalog' || domain === 'connector_catalog' || domain === 'managed_policy'
        ? ('request_scoped' as const)
        : ('process_cached' as const),
  status: 'disabled' as const,
  targetToken: null,
}));

const snapshot = {
  domains: domainSnapshot,
  freshDiagnostics: [
    {
      domains: [
        {
          domain: 'settings',
          errorCategory: null,
          loadedAt: new Date('2026-07-20T00:00:00Z'),
          loadedToken: { kind: 'revision', value: 2 },
          loadMode: 'process_cached',
          source: 'database',
          status: 'converged',
        },
      ],
      instanceId: `pinst_${'a'.repeat(48)}`,
      instanceKind: 'platform',
      lastHeartbeatAt: new Date('2026-07-20T00:00:00Z'),
      startedAt: new Date('2026-07-19T23:00:00Z'),
    },
  ],
  freshDiagnosticsTruncated: false,
  recentStaleDiagnostics: [],
  snapshotAt: new Date('2026-07-20T00:00:00Z'),
  staleDiagnosticsTruncated: false,
} as const;

describe('platform instance status internal contract', () => {
  it('accepts only discriminated revision or immutable-id tokens', () => {
    expect(platformRevisionTokenSchema.safeParse({ kind: 'revision', value: 0 }).success).toBe(
      true,
    );
    expect(
      platformRevisionTokenSchema.safeParse({ kind: 'immutable_id', value: 'b'.repeat(64) })
        .success,
    ).toBe(true);
    expect(
      platformRevisionTokenSchema.safeParse({
        immutableId: 'b'.repeat(64),
        kind: 'revision',
        value: 1,
      }).success,
    ).toBe(false);
    expect(
      platformRevisionTokenSchema.safeParse({ kind: 'immutable_id', value: 'settings:2' }).success,
    ).toBe(false);
  });

  it('closes target availability, fallback, load-mode and error semantics', () => {
    expect(
      platformDomainTargetSchema.safeParse({
        domain: 'settings',
        errorCategory: null,
        fallbackPolicy: 'none',
        loadMode: 'process_cached',
        status: 'available',
        token: { kind: 'revision', value: 0 },
      }).success,
    ).toBe(true);
    expect(
      platformDomainTargetSchema.safeParse({
        domain: 'identity',
        errorCategory: null,
        fallbackPolicy: 'lkg_then_break_glass',
        loadMode: 'restart_activated',
        status: 'available',
        token: null,
      }).success,
    ).toBe(true);
    expect(
      platformDomainTargetSchema.safeParse({
        domain: 'settings',
        errorCategory: null,
        fallbackPolicy: 'unknown',
        loadMode: 'process_cached',
        status: 'available',
        token: null,
      }).success,
    ).toBe(false);
  });

  it('accepts a bounded secret-free status snapshot', () => {
    expect(platformInstanceStatusSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it.each([
    { rawError: new Error('database URL postgresql://user:pass@host/db') },
    { endpointUrl: 'https://internal.example.test' },
    { hostnameHash: 'c'.repeat(64) },
    { secret: 'sk-sensitive-value' },
  ])('rejects non-contract diagnostic material: %o', (extra) => {
    const unsafe = {
      ...snapshot,
      freshDiagnostics: [{ ...snapshot.freshDiagnostics[0], ...extra }],
    };
    expect(platformInstanceStatusSnapshotSchema.safeParse(unsafe).success).toBe(false);
  });

  it('rejects invalid or cross-kind instance identifiers', () => {
    const invalid = {
      ...snapshot,
      freshDiagnostics: [
        {
          ...snapshot.freshDiagnostics[0],
          instanceId: `oidci_${'d'.repeat(48)}`,
          instanceKind: 'platform',
        },
      ],
    };
    expect(platformInstanceStatusSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it('requires all eight domains exactly once', () => {
    expect(
      platformInstanceStatusSnapshotSchema.safeParse({
        ...snapshot,
        domains: [...snapshot.domains.slice(0, -1), snapshot.domains[0]],
      }).success,
    ).toBe(false);
  });
});
