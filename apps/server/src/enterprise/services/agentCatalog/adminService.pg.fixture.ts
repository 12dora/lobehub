/**
 * Shared PostgreSQL fixtures for PlatformAgentAdminService ADM-04 / ADM-05 suites.
 * @vitest-environment node
 */
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import * as schema from '@/database/schemas';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformAuditLogs,
  platformUserAgentMaterializations,
} from '@/database/schemas/platform';
import { roles, userRoles } from '@/database/schemas/rbac';
import { users } from '@/database/schemas/user';
import { workspaces } from '@/database/schemas/workspace';
import type { LobeChatDatabase } from '@/database/type';

import { platformAgentDraftToken } from './publication';

export const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
export const CHECKSUM = 'a'.repeat(64);

export const config = (displayName: string) => ({
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

export const dependencySnapshot = {
  connectors: [],
  model: {
    modelKey: 'chat',
    providerChecksum: 'b'.repeat(64),
    providerKey: 'provider',
    providerRevision: 1,
  },
  skills: [],
};

export type AdminPgFixture = {
  cleanup: () => Promise<void>;
  connectionString: string;
  currentIdentity: (id: string) => Promise<typeof platformAgents.$inferSelect>;
  db: LobeChatDatabase;
  deferred: () => { promise: Promise<void>; resolve: () => void };
  pointerFor: (id: string) => Promise<{
    agentId: string;
    expectedDraftToken: string;
    expectedRevision: number;
  }>;
  rawErrorOf: (op: () => Promise<unknown>) => Promise<unknown>;
  seedDraftAgent: (id: string, agentKey: string) => Promise<void>;
  seedPublishedAgent: (id: string, agentKey: string) => Promise<string>;
};

/** Bind lifecycle hooks and return shared helpers for one pg suite file. */
export const createAdminPgFixture = (): AdminPgFixture => {
  let db!: LobeChatDatabase;
  const connectionString = process.env.DATABASE_TEST_URL!;

  const seedDraftAgent = async (id: string, agentKey: string) => {
    await db.insert(platformAgents).values({
      agentKey,
      id,
      migrationRequired: false,
      status: 'draft',
      title: agentKey,
    });
  };

  const seedPublishedAgent = async (id: string, agentKey: string) => {
    const versionId = `${id}-v1`;
    await seedDraftAgent(id, agentKey);
    await db.insert(platformAgentVersions).values({
      agentId: id,
      checksum: CHECKSUM,
      config: config(agentKey),
      dependencySnapshot,
      id: versionId,
      version: '1.0.0',
    });
    await db
      .update(platformAgents)
      .set({
        currentVersionId: versionId,
        publishedAt: new Date(),
        revision: 1,
        status: 'published',
      })
      .where(eq(platformAgents.id, id));
    return versionId;
  };

  const currentIdentity = async (id: string) => {
    const [row] = await db.select().from(platformAgents).where(eq(platformAgents.id, id));
    if (!row) throw new Error(`missing platform agent ${id}`);
    return row;
  };

  const pointerFor = async (id: string) => {
    const row = await currentIdentity(id);
    return {
      agentId: row.id,
      expectedDraftToken: platformAgentDraftToken(row),
      expectedRevision: row.revision,
    };
  };

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  };

  const rawErrorOf = async (op: () => Promise<unknown>): Promise<unknown> => {
    try {
      await op();
      throw new Error('expected a database error');
    } catch (error) {
      return error;
    }
  };

  const cleanup = async () => {
    await db.execute(sql`
      TRUNCATE TABLE
        platform_user_agent_materializations,
        platform_agent_assignments,
        platform_agent_versions,
        platform_agents,
        platform_audit_logs,
        rbac_user_roles,
        rbac_roles,
        workspaces,
        users
      RESTART IDENTITY CASCADE
    `);
  };

  beforeAll(async () => {
    db = await getTestDB();
  });

  beforeEach(cleanup);
  afterAll(cleanup);

  return {
    get connectionString() {
      return connectionString;
    },
    get db() {
      return db;
    },
    cleanup,
    currentIdentity,
    deferred,
    pointerFor,
    rawErrorOf,
    seedDraftAgent,
    seedPublishedAgent,
  };
};

// Re-export symbols used by suites that open extra pools.
export { drizzle, eq, Pool, schema, sql };
export {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformAuditLogs,
  platformUserAgentMaterializations,
  roles,
  userRoles,
  users,
  workspaces,
};
