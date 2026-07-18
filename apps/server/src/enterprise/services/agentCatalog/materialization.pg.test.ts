/**
 * Delayed materialization end-to-end against a real PostgreSQL instance (M10 PR-049 · B/C).
 *
 * Exercises the whole chain — resolver.beginOperation (owner-scoped effective auth + exact pin) →
 * PlatformAgentMaterializationService → real `agents` row + owner-scoped mapping — with the full
 * migration chain (constraints + triggers) that a mock cannot reproduce.
 *
 * @vitest-environment node
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import { createUnmanagedResourcePolicyMap } from '@/database/models/platform';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import { agents } from '@/database/schemas/agent';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformAgentEffectiveResolver } from './effectiveResolver';
import {
  PlatformAgentInvalidInputError,
  PlatformAgentMaterializationError,
  PlatformAgentNotFoundError,
} from './errors';
import { PlatformAgentMaterializationService } from './materialization';

const flags = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true };
const CHECKSUM_V1 = 'a'.repeat(64);
const CHECKSUM_V2 = 'c'.repeat(64);

const config = (displayName: string) => ({
  avatar: 'a.png',
  backgroundColor: '#111111',
  description: `${displayName} desc`,
  displayName,
  modelParameters: { maxTokens: 2048 },
  openingMessage: null,
  openingQuestions: [],
  systemRole: `${displayName} role`,
  tags: [],
});

const dependencySnapshot = {
  connectors: [],
  model: {
    modelKey: 'chat-model',
    providerChecksum: 'b'.repeat(64),
    providerKey: 'internal-provider',
    providerRevision: 1,
  },
  skills: [],
};

const managedPolicy = () => {
  const published = createUnmanagedResourcePolicyMap();
  published.agents = { enforcementMode: 'enforced' as const, managed: true };
  return {
    draft: createUnmanagedResourcePolicyMap(),
    published,
    revision: 1,
    status: 'published' as const,
  };
};

const db: LobeChatDatabase = await getTestDB();

const resolver = () =>
  new PlatformAgentEffectiveResolver(db, {
    flags,
    policyModel: { getSnapshot: async () => managedPolicy() },
  });

const service = (userId: string) => new PlatformAgentMaterializationService(db, userId);

const checksumFor = (versionRow: { checksum: string | null }) => versionRow.checksum!;

/** Insert a published Agent with a v1 version + a global assignment (latest_published). */
const seedPublishedAgent = async (
  id: string,
  mode: 'default' | 'mandatory' | 'optional' = 'optional',
) => {
  await db.insert(platformAgents).values({
    agentKey: id,
    id,
    migrationRequired: false,
    status: 'draft',
    title: id,
  });
  const [v1] = await db
    .insert(platformAgentVersions)
    .values({
      agentId: id,
      checksum: CHECKSUM_V1,
      config: config(`${id} v1`),
      dependencySnapshot,
      id: `${id}-v1`,
      version: '1.0.0',
    })
    .returning();
  await db
    .update(platformAgents)
    .set({ currentVersionId: v1.id, publishedAt: new Date(), revision: 1, status: 'published' })
    .where(eq(platformAgents.id, id));
  await db.insert(platformAgentAssignments).values({
    agentId: id,
    enabled: true,
    id: `${id}-global`,
    mode,
    status: 'active',
    targetId: '__global__',
    targetType: 'global',
    versionPolicy: 'latest_published',
  });
  return v1;
};

/** Publish a v2 version and advance the current pointer. */
const publishV2 = async (id: string) => {
  const [v2] = await db
    .insert(platformAgentVersions)
    .values({
      agentId: id,
      checksum: CHECKSUM_V2,
      config: config(`${id} v2`),
      dependencySnapshot,
      id: `${id}-v2`,
      version: '2.0.0',
    })
    .returning();
  await db
    .update(platformAgents)
    .set({ currentVersionId: v2.id, revision: 2 })
    .where(eq(platformAgents.id, id));
  return v2;
};

const mappingRow = async (userId: string, platformAgentId: string) => {
  const [row] = await db
    .select()
    .from(platformUserAgentMaterializations)
    .where(
      and(
        eq(platformUserAgentMaterializations.userId, userId),
        eq(platformUserAgentMaterializations.platformAgentId, platformAgentId),
      ),
    );
  return row;
};

const beginSnapshot = async (userId: string, platformAgentId: string) => {
  const handle = await resolver().beginOperation(userId, platformAgentId);
  if (!handle) throw new Error('expected an entitled operation handle');
  return handle.getSnapshot();
};

// Immutable-version + reference triggers block row DELETEs, so reset via TRUNCATE CASCADE.
const cleanup = () =>
  db.execute(sql`
      TRUNCATE TABLE
        ${platformUserAgentMaterializations},
        ${platformAgentAssignments},
        ${platformAgentVersions},
        ${platformAgents},
        ${agents},
        ${users}
      RESTART IDENTITY CASCADE
    `);

describe('PlatformAgentMaterializationService (PostgreSQL) — delayed materialization', () => {
  beforeEach(async () => {
    await cleanup();
    await db.insert(users).values([{ id: 'user-a' }, { id: 'user-b' }]);
  });
  afterEach(cleanup);

  it('materializes a real user-owned Agent from the pinned version on first use', async () => {
    await seedPublishedAgent('agent-1');
    const snapshot = await beginSnapshot('user-a', 'agent-1');

    const { agentId, config: runtime } = await service('user-a').materializeForOperation(snapshot);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row.userId).toBe('user-a');
    expect(row.title).toBe('agent-1 v1');
    expect(row.model).toBe('chat-model');
    expect(row.provider).toBe('internal-provider');
    expect(runtime).toMatchObject({ id: agentId, model: 'chat-model', title: 'agent-1 v1' });

    const mapping = await mappingRow('user-a', 'agent-1');
    expect(mapping).toMatchObject({
      materializedAgentId: agentId,
      platformAgentVersionId: 'agent-1-v1',
      status: 'materialized',
    });
  });

  it('reuses the same local Agent on repeat and never creates a second row', async () => {
    await seedPublishedAgent('agent-1');
    const first = await service('user-a').materializeForOperation(
      await beginSnapshot('user-a', 'agent-1'),
    );
    const second = await service('user-a').materializeForOperation(
      await beginSnapshot('user-a', 'agent-1'),
    );
    expect(second.agentId).toBe(first.agentId);
    const rows = await db.select().from(agents).where(eq(agents.userId, 'user-a'));
    expect(rows).toHaveLength(1);
  });

  it('keeps an in-flight v1 operation on v1 after v2 is published; a new operation gets v2', async () => {
    const v1 = await seedPublishedAgent('agent-1');
    // Operation A captures v1 BEFORE v2 exists.
    const snapshotA = await beginSnapshot('user-a', 'agent-1');
    expect(snapshotA.versionId).toBe('agent-1-v1');
    expect(snapshotA.checksum).toBe(checksumFor(v1));

    await publishV2('agent-1');
    // A new operation B resolves the advanced pointer → v2.
    const snapshotB = await beginSnapshot('user-a', 'agent-1');
    expect(snapshotB.versionId).toBe('agent-1-v2');

    const a = await service('user-a').materializeForOperation(snapshotA);
    const b = await service('user-a').materializeForOperation(snapshotB);
    // Same attribution Agent, but each operation's runtime config stays pinned to its snapshot.
    expect(b.agentId).toBe(a.agentId);
    expect(a.config.title).toBe('agent-1 v1');
    expect(b.config.title).toBe('agent-1 v2');
  });

  it('is owner-scoped: user B gets an isolated Agent, never user A’s', async () => {
    await seedPublishedAgent('agent-1');
    const a = await service('user-a').materializeForOperation(
      await beginSnapshot('user-a', 'agent-1'),
    );
    const b = await service('user-b').materializeForOperation(
      await beginSnapshot('user-b', 'agent-1'),
    );
    expect(b.agentId).not.toBe(a.agentId);
    expect((await db.select().from(agents).where(eq(agents.id, a.agentId)))[0].userId).toBe(
      'user-a',
    );
    expect((await db.select().from(agents).where(eq(agents.id, b.agentId)))[0].userId).toBe(
      'user-b',
    );
  });

  it('fails closed on a checksum mismatch without creating an Agent or mapping', async () => {
    await seedPublishedAgent('agent-1');
    const snapshot = await beginSnapshot('user-a', 'agent-1');

    await expect(
      service('user-a').materializeForOperation({ ...snapshot, checksum: 'f'.repeat(64) }),
    ).rejects.toBeInstanceOf(PlatformAgentMaterializationError);

    expect(await db.select().from(agents).where(eq(agents.userId, 'user-a'))).toHaveLength(0);
    expect(await mappingRow('user-a', 'agent-1')).toBeUndefined();
  });

  it('rejects a lost archive race as NotFound and leaves no orphan Agent', async () => {
    await seedPublishedAgent('agent-1');
    const snapshot = await beginSnapshot('user-a', 'agent-1');
    // Archive after the snapshot is captured but before materialize.
    await db
      .update(platformAgents)
      .set({ status: 'archived' })
      .where(eq(platformAgents.id, 'agent-1'));

    await expect(service('user-a').materializeForOperation(snapshot)).rejects.toBeInstanceOf(
      PlatformAgentNotFoundError,
    );
    expect(await db.select().from(agents).where(eq(agents.userId, 'user-a'))).toHaveLength(0);
  });

  it('is a no-op on the catalog for a user with no effective assignment', async () => {
    await seedPublishedAgent('agent-1');
    // user-b is entitled via the global assignment; remove it so nobody is entitled.
    await db
      .delete(platformAgentAssignments)
      .where(eq(platformAgentAssignments.agentId, 'agent-1'));
    const handle = await resolver().beginOperation('user-a', 'agent-1');
    expect(handle).toBeNull();
    expect(await new PlatformAgentCatalogRepository(db).listMaterializedAgentIds('user-a')).toEqual(
      new Set(),
    );
  });

  // ROOT-01 — owner-scoped setHidden: mandatory not hideable, default/optional hideable, and the
  // toggle never materializes a local Agent (visibility-only row).
  describe('setAgentHidden (ROOT-01)', () => {
    it('rejects hiding a mandatory Agent', async () => {
      await seedPublishedAgent('mand-agent', 'mandatory');
      await expect(resolver().setAgentHidden('user-a', 'mand-agent', true)).rejects.toBeInstanceOf(
        PlatformAgentInvalidInputError,
      );
      expect(await mappingRow('user-a', 'mand-agent')).toBeUndefined();
    });

    it('hides an optional Agent as a visibility-only row without materializing a local Agent', async () => {
      await seedPublishedAgent('opt-agent', 'optional');
      await resolver().setAgentHidden('user-a', 'opt-agent', true);

      const row = await mappingRow('user-a', 'opt-agent');
      expect(row).toMatchObject({ hidden: true, materializedAgentId: null });
      expect(row.lastSyncedAt).toBeNull();
      expect(await db.select().from(agents).where(eq(agents.userId, 'user-a'))).toHaveLength(0);

      // Owner-scoped: user-b is unaffected.
      expect(await mappingRow('user-b', 'opt-agent')).toBeUndefined();
    });

    it('rejects hiding an Agent the user is not entitled to', async () => {
      await seedPublishedAgent('opt-agent', 'optional');
      await db
        .delete(platformAgentAssignments)
        .where(eq(platformAgentAssignments.agentId, 'opt-agent'));
      await expect(resolver().setAgentHidden('user-a', 'opt-agent', true)).rejects.toBeInstanceOf(
        PlatformAgentNotFoundError,
      );
    });
  });
});
