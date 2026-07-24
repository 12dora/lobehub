import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import { PLATFORM_CONVERGENCE_DOMAINS } from '@/server/enterprise/contracts/platformInstanceStatus';

import { buildAiCatalogRevisionToken } from './catalogTokens';
import { PlatformDomainTargetResolver } from './domainTargets';

const CHECKSUM = 'a'.repeat(64);
const ALL_FLAGS = {
  ENABLE_DATABASE_OIDC: '1',
  ENABLE_PLATFORM_MANAGED_AGENTS: '1',
  ENABLE_PLATFORM_MANAGED_AI: '1',
  ENABLE_PLATFORM_MANAGED_CONNECTORS: '1',
  ENABLE_PLATFORM_MANAGED_SKILLS: '1',
  ENABLE_PLATFORM_SETTINGS_POLICY: '1',
  ENABLE_RUNTIME_BRANDING: '1',
};

const fakeDatabase = (result: unknown[] | Error) => {
  const query = Object.assign(
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    {
      leftJoin: vi.fn(),
      limit: vi.fn(),
      orderBy: vi.fn(),
      where: vi.fn(),
    },
  );
  query.leftJoin.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.where.mockReturnValue(query);
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => query) })),
  } as unknown as LobeChatDatabase;
  return { db, select: db.select as ReturnType<typeof vi.fn> };
};

/** Matches `loadPublishedIdentityTarget`: identityRevision is always a non-null checksum string. */
const identityLoader = (identityRevision: string = CHECKSUM) =>
  vi.fn(async () => ({
    environmentShadowed: [] as { providerId: string; providerKey: string }[],
    identityRevision,
    // Empty providers is valid; never[] is assignable to the published-provider array type.
    providers: [],
  }));

describe('PlatformDomainTargetResolver', () => {
  it('does zero database and identity work when every feature is disabled', async () => {
    const select = vi.fn(() => {
      throw new Error('database must not be queried');
    });
    const db = { select } as unknown as LobeChatDatabase;
    const loadIdentityTarget = identityLoader();

    const targets = await new PlatformDomainTargetResolver(db, {
      env: {},
      loadIdentityTarget,
    }).resolveAll();

    expect(targets.map(({ domain }) => domain)).toEqual(PLATFORM_CONVERGENCE_DOMAINS);
    expect(targets.every(({ status, token }) => status === 'disabled' && token === null)).toBe(
      true,
    );
    expect(select).not.toHaveBeenCalled();
    expect(loadIdentityTarget).not.toHaveBeenCalled();
  });

  it.each([
    {
      domain: 'settings' as const,
      expected: { kind: 'revision', value: 0 },
      rows: [],
    },
    {
      domain: 'settings' as const,
      expected: { kind: 'revision', value: 7 },
      rows: [{ revision: 7, status: 'published' }],
    },
    {
      domain: 'branding' as const,
      expected: { kind: 'revision', value: 3 },
      rows: [{ revision: 3 }],
    },
    {
      domain: 'managed_policy' as const,
      expected: { kind: 'revision', value: 4 },
      rows: ['agents', 'aiModels', 'aiProviders', 'connectors', 'skills'].map((resource) => ({
        resource,
        revision: 4,
        status: 'published',
      })),
    },
  ])('resolves the authoritative $domain revision pointer', async ({ domain, expected, rows }) => {
    const { db } = fakeDatabase(rows);
    const target = await new PlatformDomainTargetResolver(db, { env: ALL_FLAGS }).resolve(domain);
    expect(target).toMatchObject({ status: 'available', token: expected });
  });

  it.each([
    {
      domain: 'ai_catalog' as const,
      rows: [
        {
          checksum: CHECKSUM,
          providerId: 'provider-1',
          providerKey: 'provider',
          revision: 1,
          secretFingerprint: null,
        },
      ],
    },
    {
      domain: 'skill_catalog' as const,
      rows: [
        {
          allowBuiltinOverride: false,
          checksum: CHECKSUM,
          currentVersionId: 'skill-version-1',
          enabled: true,
          revision: 1,
          skillId: 'skill-1',
          skillKey: 'skill',
          status: 'published',
        },
      ],
    },
    {
      domain: 'connector_catalog' as const,
      rows: [
        {
          checksum: CHECKSUM,
          connectorId: 'connector-1',
          connectorKey: 'connector',
          revision: 1,
        },
      ],
    },
    {
      domain: 'agent_catalog' as const,
      rows: [
        {
          agentId: 'agent-1',
          agentKey: 'agent',
          checksum: CHECKSUM,
          currentVersionId: 'agent-version-1',
          revision: 1,
        },
      ],
    },
  ])('resolves $domain as an opaque immutable token', async ({ domain, rows }) => {
    const { db } = fakeDatabase(rows);
    const target = await new PlatformDomainTargetResolver(db, {
      env: ALL_FLAGS,
      loadAiCatalogSnapshot: async () => ({
        revisions: [],
        token: buildAiCatalogRevisionToken([
          {
            checksum: CHECKSUM,
            providerId: 'provider-1',
            providerKey: 'provider',
            revision: 1,
            secretFingerprint: null,
          },
        ]),
      }),
      loadBuiltinSkillTokenEntries: () => [],
      loadSkillCatalogSnapshot: async () => ({
        builtinOverrideTombstones: [],
        items: [],
        tokenEntries: [
          {
            checksum: CHECKSUM,
            currentVersionId: 'skill-version-1',
            revision: 1,
            skillId: 'skill-1',
            skillKey: 'skill',
            tombstone: false,
          },
        ],
      }),
    }).resolve(domain);
    expect(target.status).toBe('available');
    expect(target.token).toMatchObject({ kind: 'immutable_id' });
    expect(target.token?.value).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses the OIDC published-target loader and permits the no-provider target', async () => {
    const { db, select } = fakeDatabase([]);
    // Empty provider set still yields a non-null identityRevision (digest of []).
    const loadIdentityTarget = identityLoader(CHECKSUM);
    const target = await new PlatformDomainTargetResolver(db, {
      env: ALL_FLAGS,
      loadIdentityTarget,
    }).resolve('identity');

    expect(target).toMatchObject({
      fallbackPolicy: 'lkg_then_break_glass',
      loadMode: 'restart_activated',
      status: 'available',
      token: { kind: 'immutable_id', value: CHECKSUM },
    });
    expect(loadIdentityTarget).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
  });

  it.each([
    ['settings', [{ revision: 2, status: 'draft' }]],
    ['branding', []],
    [
      'managed_policy',
      ['agents', 'aiModels', 'aiProviders', 'connectors'].map((resource) => ({
        resource,
        revision: 1,
        status: 'published',
      })),
    ],
    [
      'agent_catalog',
      [
        {
          agentId: 'agent-1',
          agentKey: 'agent',
          checksum: null,
          currentVersionId: 'agent-version-1',
          revision: 1,
        },
      ],
    ],
  ] as const)('reports configuration-invalid for an invalid %s pointer', async (domain, rows) => {
    const { db } = fakeDatabase([...rows]);
    const target = await new PlatformDomainTargetResolver(db, { env: ALL_FLAGS }).resolve(domain);
    expect(target).toMatchObject({
      errorCategory: 'configuration_invalid',
      status: 'unavailable',
      token: null,
    });
  });

  it('isolates one domain database failure from every other target', async () => {
    const successful = fakeDatabase([]);
    const db = {
      select: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('database unavailable');
        })
        .mockImplementation(() => successful.db.select()),
    } as unknown as LobeChatDatabase;
    const resolver = new PlatformDomainTargetResolver(db, {
      env: { ENABLE_PLATFORM_MANAGED_AGENTS: '1', ENABLE_PLATFORM_MANAGED_AI: '1' },
    });

    const [agent, ai] = await Promise.all([
      resolver.resolve('agent_catalog'),
      resolver.resolve('ai_catalog'),
    ]);
    expect(agent).toMatchObject({ errorCategory: 'database_unavailable', status: 'unavailable' });
    expect(ai).toMatchObject({ status: 'available' });
  });
});
