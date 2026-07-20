import { describe, expect, it } from 'vitest';

import {
  PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS,
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
  fallbackPolicy: PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[domain].fallbackPolicy,
  loadMode: PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS[domain].loadMode,
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
  it('pins one load, fallback and token descriptor for every domain', () => {
    expect(PLATFORM_CONVERGENCE_DOMAIN_DESCRIPTORS).toEqual({
      agent_catalog: {
        fallbackPolicy: 'none',
        loadMode: 'request_scoped',
        tokenKind: 'immutable_id',
      },
      ai_catalog: {
        fallbackPolicy: 'none',
        loadMode: 'process_cached',
        tokenKind: 'immutable_id',
      },
      branding: {
        fallbackPolicy: 'builtin',
        loadMode: 'process_cached',
        tokenKind: 'revision',
      },
      connector_catalog: {
        fallbackPolicy: 'none',
        loadMode: 'request_scoped',
        tokenKind: 'immutable_id',
      },
      identity: {
        fallbackPolicy: 'lkg_then_break_glass',
        loadMode: 'restart_activated',
        tokenKind: 'immutable_id_or_null',
      },
      managed_policy: {
        fallbackPolicy: 'none',
        loadMode: 'request_scoped',
        tokenKind: 'revision',
      },
      settings: {
        fallbackPolicy: 'none',
        loadMode: 'process_cached',
        tokenKind: 'revision',
      },
      skill_catalog: {
        fallbackPolicy: 'none',
        loadMode: 'process_cached',
        tokenKind: 'immutable_id',
      },
    });
  });

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
        fallbackPolicy: 'none',
        loadMode: 'process_cached',
        status: 'available',
        token: null,
      }).success,
    ).toBe(false);
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

  it('rejects domain metadata and token kinds that drift from the descriptor', () => {
    expect(
      platformDomainTargetSchema.safeParse({
        domain: 'settings',
        errorCategory: null,
        fallbackPolicy: 'lkg_then_break_glass',
        loadMode: 'restart_activated',
        status: 'available',
        token: { kind: 'revision', value: 1 },
      }).success,
    ).toBe(false);
    expect(
      platformDomainTargetSchema.safeParse({
        domain: 'identity',
        errorCategory: null,
        fallbackPolicy: 'lkg_then_break_glass',
        loadMode: 'process_cached',
        status: 'available',
        token: { kind: 'revision', value: 1 },
      }).success,
    ).toBe(false);
  });

  it('accepts a bounded secret-free status snapshot', () => {
    expect(platformInstanceStatusSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('rejects target tokens on disabled and request-scoped not-applicable domains', () => {
    for (const status of ['disabled', 'not_applicable'] as const) {
      expect(
        platformInstanceStatusSnapshotSchema.safeParse({
          ...snapshot,
          domains: snapshot.domains.map((domain, index) =>
            index === 0
              ? { ...domain, status, targetToken: { kind: 'revision', value: 1 } }
              : domain,
          ),
        }).success,
      ).toBe(false);
    }
  });

  it('rejects unavailable targets and domain summaries that carry a token', () => {
    expect(
      platformDomainTargetSchema.safeParse({
        domain: 'settings',
        errorCategory: 'database_unavailable',
        fallbackPolicy: 'none',
        loadMode: 'process_cached',
        status: 'unavailable',
        token: { kind: 'revision', value: 1 },
      }).success,
    ).toBe(false);
    expect(
      platformInstanceStatusSnapshotSchema.safeParse({
        ...snapshot,
        domains: snapshot.domains.map((domain) =>
          domain.domain === 'settings'
            ? {
                ...domain,
                errorCategory: 'database_unavailable',
                status: 'unavailable',
                targetToken: { kind: 'revision', value: 1 },
              }
            : domain,
        ),
      }).success,
    ).toBe(false);
  });

  it('rejects impossible converged diagnostic outcome combinations', () => {
    expect(
      platformInstanceStatusSnapshotSchema.safeParse({
        ...snapshot,
        freshDiagnostics: [
          {
            ...snapshot.freshDiagnostics[0],
            domains: [
              {
                domain: 'settings',
                errorCategory: 'load_failed',
                loadedAt: null,
                loadedToken: null,
                loadMode: 'process_cached',
                source: 'unavailable',
                status: 'converged',
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects settings restart/LKG and identity process-cached/revision diagnostics', () => {
    const invalidDiagnostics = [
      {
        ...snapshot.freshDiagnostics[0],
        domains: [
          {
            domain: 'settings',
            errorCategory: 'lkg_unavailable',
            loadedAt: new Date('2026-07-20T00:00:00Z'),
            loadedToken: { kind: 'revision', value: 1 },
            loadMode: 'restart_activated',
            source: 'lkg',
            status: 'degraded',
          },
        ],
      },
      {
        ...snapshot.freshDiagnostics[0],
        domains: [
          {
            domain: 'identity',
            errorCategory: null,
            loadedAt: new Date('2026-07-20T00:00:00Z'),
            loadedToken: { kind: 'revision', value: 1 },
            loadMode: 'process_cached',
            source: 'database',
            status: 'converged',
          },
        ],
        instanceId: `oidci_${'e'.repeat(48)}`,
        instanceKind: 'identity_startup',
      },
    ];
    for (const diagnostic of invalidDiagnostics) {
      expect(
        platformInstanceStatusSnapshotSchema.safeParse({
          ...snapshot,
          freshDiagnostics: [diagnostic],
        }).success,
      ).toBe(false);
    }
  });

  it('rejects duplicate and cross-namespace diagnostic domains', () => {
    const settings = snapshot.freshDiagnostics[0].domains[0];
    for (const diagnostic of [
      { ...snapshot.freshDiagnostics[0], domains: [settings, settings] },
      {
        ...snapshot.freshDiagnostics[0],
        domains: [
          {
            domain: 'identity',
            errorCategory: null,
            loadedAt: new Date('2026-07-20T00:00:00Z'),
            loadedToken: null,
            loadMode: 'restart_activated',
            source: 'database',
            status: 'converged',
          },
        ],
      },
      {
        ...snapshot.freshDiagnostics[0],
        domains: [settings],
        instanceId: `oidci_${'d'.repeat(48)}`,
        instanceKind: 'identity_startup',
      },
    ]) {
      expect(
        platformInstanceStatusSnapshotSchema.safeParse({
          ...snapshot,
          freshDiagnostics: [diagnostic],
        }).success,
      ).toBe(false);
    }
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
