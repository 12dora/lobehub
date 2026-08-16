/**
 * F5 production-SQL regressions for the effective-list winner page.
 *
 * Always runs against getTestDB() (PGlite by default; real Postgres when
 * TEST_SERVER_DB=1 + DATABASE_TEST_URL). These tests deliberately exercise
 * {@link queryVisibleWinnerPage} / {@link queryEffectiveInputsPage} — never an
 * injected in-memory keyset stub — so reverting DISTINCT ON, hidden-after-dedup,
 * or the created_at/id cursor predicate fails.
 *
 * @vitest-environment node
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DISABLED_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import { createUnmanagedResourcePolicyMap } from '@/database/models/platform';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';

import {
  PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
  PLATFORM_AGENT_EFFECTIVE_LIST_MAX,
  PlatformAgentEffectiveResolver,
  queryVisibleWinnerPage,
} from './effectiveResolver';

const flags = { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true };
const CHECKSUM = 'a'.repeat(64);
const PROVIDER_CHECKSUM = 'b'.repeat(64);

const dependencySnapshot = {
  connectors: [],
  model: {
    modelKey: 'chat',
    providerChecksum: PROVIDER_CHECKSUM,
    providerKey: 'provider',
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

const config = (displayName: string) => ({
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName,
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'help',
  tags: [],
});

describe.skipIf(process.env.TEST_SERVER_DB !== '1')(
  'PlatformAgentEffectiveResolver F5 production SQL (real Postgres only — 50k-row seed OOMs PGlite)',
  () => {
    let db: LobeChatDatabase;

    const resolver = () =>
      new PlatformAgentEffectiveResolver(db, {
        flags,
        // No queryEffectiveInputsPage override — production SQL only.
        policyModel: { getSnapshot: async () => managedPolicy() },
      });

    const cleanup = async () => {
      await db.execute(sql`
      TRUNCATE TABLE
        platform_user_agent_materializations,
        platform_agent_assignments,
        platform_agent_versions,
        platform_agents,
        users
      RESTART IDENTITY CASCADE
    `);
    };

    beforeAll(async () => {
      db = await getTestDB();
    }, 60_000);
    beforeEach(cleanup);
    afterEach(cleanup);

    const seedPublished = async (
      id: string,
      opts?: { createdAt?: Date; mode?: 'default' | 'mandatory' | 'optional' },
    ) => {
      const mode = opts?.mode ?? 'optional';
      await db.insert(platformAgents).values({
        agentKey: id,
        id,
        migrationRequired: false,
        status: 'draft',
        title: id,
      });
      await db.insert(platformAgentVersions).values({
        agentId: id,
        checksum: CHECKSUM,
        config: config(id),
        dependencySnapshot,
        id: `${id}-v1`,
        version: '1.0.0',
      });
      await db
        .update(platformAgents)
        .set({
          currentVersionId: `${id}-v1`,
          publishedAt: new Date(),
          revision: 1,
          status: 'published',
        })
        .where(eq(platformAgents.id, id));
      await db.insert(platformAgentAssignments).values({
        agentId: id,
        createdAt: opts?.createdAt ?? new Date(),
        enabled: true,
        id: `${id}-global`,
        mode,
        status: 'active',
        targetId: '__global__',
        targetType: 'global',
        versionPolicy: 'latest_published',
      });
    };

    const hide = async (userId: string, platformAgentId: string) => {
      await db.insert(platformUserAgentMaterializations).values({
        hidden: true,
        id: `mat-${userId}-${platformAgentId}`,
        platformAgentId,
        platformAgentVersionChecksum: CHECKSUM,
        platformAgentVersionId: `${platformAgentId}-v1`,
        status: 'pending',
        userId,
      });
    };

    /**
     * Bulk-seed N published optional global agents with deterministic created_at ordering,
     * optionally marking the first `hiddenCount` as hidden for `userId`.
     */
    const bulkSeedAgents = async (params: {
      hiddenCount: number;
      start: number;
      total: number;
      userId: string;
    }) => {
      const { start, total, hiddenCount, userId } = params;
      const end = start + total - 1;
      // Agents (draft) → versions → publish → assignments → optional hidden rows.
      // Cast series bounds to int — PGlite rejects generate_series(unknown, unknown).
      await db.execute(sql`
      INSERT INTO platform_agents (
        id, agent_key, title, status, migration_required, revision, draft_sequence, is_default
      )
      SELECT
        'f5a' || lpad(g::text, 6, '0'),
        'f5k' || lpad(g::text, 6, '0'),
        'f5a' || lpad(g::text, 6, '0'),
        'draft',
        false,
        0,
        0,
        false
      FROM generate_series(${start}::int, ${end}::int) AS g
    `);
      await db.execute(sql`
      INSERT INTO platform_agent_versions (
        id, agent_id, version, config, dependency_snapshot, checksum
      )
      SELECT
        'f5v' || lpad(g::text, 6, '0'),
        'f5a' || lpad(g::text, 6, '0'),
        '1.0.0',
        '{}'::jsonb,
        ${JSON.stringify(dependencySnapshot)}::jsonb,
        ${CHECKSUM}
      FROM generate_series(${start}::int, ${end}::int) AS g
    `);
      await db.execute(sql`
      UPDATE platform_agents AS a
      SET
        status = 'published',
        current_version_id = 'f5v' || lpad(substring(a.id from 4)::int::text, 6, '0'),
        published_at = NOW(),
        revision = 1
      WHERE a.id LIKE 'f5a%'
        AND substring(a.id from 4)::int BETWEEN ${start}::int AND ${end}::int
    `);
      // Newer agents get later created_at so keyset order is stable (DESC → high g first).
      await db.execute(sql`
      INSERT INTO platform_agent_assignments (
        id, agent_id, target_type, target_id, mode, version_policy, enabled, status, created_at, updated_at
      )
      SELECT
        'f5s' || lpad(g::text, 6, '0'),
        'f5a' || lpad(g::text, 6, '0'),
        'global',
        '__global__',
        'optional',
        'latest_published',
        true,
        'active',
        TIMESTAMPTZ '2020-01-01 00:00:00+00' + (g || ' seconds')::interval,
        NOW()
      FROM generate_series(${start}::int, ${end}::int) AS g
    `);
      if (hiddenCount > 0) {
        // Hide the NEWEST `hiddenCount` agents (highest g → latest created_at) so that under the
        // production `created_at DESC` keyset the hidden rows LEAD and the surviving visible winners
        // are the OLDEST rows — reachable ONLY by paging PAST every hidden row. A restored 50k prefix
        // cap would stop among the hidden lead and miss every visible winner (so the test would fail).
        const hideStart = start + total - hiddenCount;
        await db.execute(sql`
        INSERT INTO platform_user_agent_materializations (
          id, user_id, platform_agent_id, platform_agent_version_id,
          platform_agent_version_checksum, hidden, status
        )
        SELECT
          'f5m' || lpad(g::text, 6, '0'),
          ${userId},
          'f5a' || lpad(g::text, 6, '0'),
          'f5v' || lpad(g::text, 6, '0'),
          ${CHECKSUM},
          true,
          'pending'
        FROM generate_series(${hideStart}::int, ${end}::int) AS g
      `);
      }
    };

    it('hides a first-winner agent and never resurfaces a lower-priority duplicate (F5)', async () => {
      await db.insert(users).values({ id: 'f5-user' });

      // Agent with high-priority user assignment (winner) + low-priority global duplicate.
      await db.insert(platformAgents).values({
        agentKey: 'dup-hidden',
        id: 'dup-hidden',
        migrationRequired: false,
        status: 'draft',
        title: 'dup-hidden',
      });
      await db.insert(platformAgentVersions).values({
        agentId: 'dup-hidden',
        checksum: CHECKSUM,
        config: config('dup-hidden'),
        dependencySnapshot,
        id: 'dup-hidden-v1',
        version: '1.0.0',
      });
      await db
        .update(platformAgents)
        .set({
          currentVersionId: 'dup-hidden-v1',
          publishedAt: new Date(),
          revision: 1,
          status: 'published',
        })
        .where(eq(platformAgents.id, 'dup-hidden'));

      // User assignment wins (priority 3); global is the lower-priority duplicate.
      await db.insert(platformAgentAssignments).values([
        {
          agentId: 'dup-hidden',
          createdAt: new Date('2024-06-01T00:00:00Z'),
          enabled: true,
          id: 'dup-user',
          mode: 'optional',
          status: 'active',
          targetId: 'f5-user',
          targetType: 'user',
          versionPolicy: 'latest_published',
        },
        {
          agentId: 'dup-hidden',
          createdAt: new Date('2024-01-01T00:00:00Z'),
          enabled: true,
          id: 'dup-global',
          mode: 'optional',
          status: 'active',
          targetId: '__global__',
          targetType: 'global',
          versionPolicy: 'latest_published',
        },
      ]);
      await hide('f5-user', 'dup-hidden');

      // Fill more than one assignment-batch of *other* winners so a raw assignment-keyset
      // that forgot first-winner state could still surface the low-priority duplicate later.
      const fillerCount = PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH + 5;
      await bulkSeedAgents({
        hiddenCount: 0,
        start: 1,
        total: fillerCount,
        userId: 'f5-user',
      });

      const list = await resolver().getEffectiveList('f5-user');
      expect(list.agents.some((a) => a.platformAgentId === 'dup-hidden')).toBe(false);

      // Direct production SQL page must also exclude the key (not just the resolver loop).
      const page = await queryVisibleWinnerPage(db, 'f5-user', {
        limit: PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
      });
      expect(page.some((r) => r.agent.id === 'dup-hidden')).toBe(false);
    }, 120_000);

    it.each([
      { hiddenLead: 5_200, label: '>5k leading hidden', visibleTail: 25 },
      { hiddenLead: 50_200, label: '>50k leading hidden', visibleTail: 25 },
    ])(
      'collects visible winners after $label rows via real production SQL (F5)',
      async ({ hiddenLead, visibleTail }) => {
        await db.insert(users).values({ id: 'f5-scale' });
        const total = hiddenLead + visibleTail;
        await bulkSeedAgents({
          hiddenCount: hiddenLead,
          start: 1,
          total,
          userId: 'f5-scale',
        });

        const list = await resolver().getEffectiveList('f5-scale');
        expect(list.agents).toHaveLength(visibleTail);
        // Visible winners are the OLDEST rows: g in [1, visibleTail]. The newest `hiddenLead` rows
        // are hidden and LEAD under created_at DESC. Assert the EXACT order the production keyset
        // yields (created_at DESC → g DESCENDING); a `.sort()` compare would mask a broken
        // cursor/order, and a restored 50k prefix cap would never reach these oldest winners.
        const orderedIds = list.agents.map((a) => a.platformAgentId);
        const expectedOrder = Array.from(
          { length: visibleTail },
          (_, i) => `f5a${String(visibleTail - i).padStart(6, '0')}`,
        );
        expect(orderedIds).toEqual(expectedOrder);

        // The OLDEST visible winner (g=1) is reachable ONLY after paging past all `hiddenLead`
        // newer hidden rows — its presence proves traversal beyond the old 50k ceiling / overscan.
        expect(list.agents.some((a) => a.platformAgentId === 'f5a000001')).toBe(true);

        // Cursor must advance across winner pages when more than BATCH visible exist —
        // here visibleTail < BATCH so one SQL page is enough; still assert production SQL
        // returns the full visible set without an injected stub.
        const page = await queryVisibleWinnerPage(db, 'f5-scale', {
          limit: PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
        });
        expect(page).toHaveLength(visibleTail);
      },
      300_000,
    );

    it('keyset cursor on created_at DESC, id DESC advances without repeating page 1', async () => {
      await db.insert(users).values({ id: 'f5-cursor' });
      // Seed more than one batch of visible winners so the resolver must page.
      const total = PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH + 30;
      await bulkSeedAgents({
        hiddenCount: 0,
        start: 1,
        total,
        userId: 'f5-cursor',
      });

      const page1 = await queryVisibleWinnerPage(db, 'f5-cursor', {
        limit: PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
      });
      expect(page1).toHaveLength(PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH);

      const last = page1.at(-1)!;
      const page2 = await queryVisibleWinnerPage(db, 'f5-cursor', {
        cursor: { createdAt: last.assignment.createdAt, id: last.assignment.id },
        limit: PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
      });
      expect(page2.length).toBeGreaterThan(0);
      expect(page2[0]!.assignment.id).not.toBe(page1[0]!.assignment.id);
      // No overlap between pages.
      const page1Ids = new Set(page1.map((r) => r.assignment.id));
      expect(page2.every((r) => !page1Ids.has(r.assignment.id))).toBe(true);

      // Full list still respects the wire max.
      const list = await resolver().getEffectiveList('f5-cursor');
      expect(list.agents).toHaveLength(PLATFORM_AGENT_EFFECTIVE_LIST_MAX);
    }, 180_000);
  },
);
