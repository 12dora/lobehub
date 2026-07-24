// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform/checksum';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformAuditLogs,
  platformJobs,
  platformUserAgentMaterializations,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { platformAgentDraftToken } from './publication';

export const db: LobeChatDatabase = await getTestDB();
export const runPostgres =
  process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
export const checksum = 'a'.repeat(64);
export const dependencies = {
  connectors: [],
  model: {
    modelKey: 'chat',
    providerChecksum: checksum,
    providerKey: 'provider',
    providerRevision: 1,
  },
  skills: [],
};
export const config = (displayName: string) => ({
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName,
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Support',
  tags: [],
});

const cleanup = () =>
  db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformJobs},
      ${platformAgentAssignments},
      ${platformUserAgentMaterializations},
      ${platformAgentVersions},
      ${platformAgents},
      ${userRoles},
      ${roles},
      ${users}
    CASCADE
  `);

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values([{ id: 'admin' }, { id: 'user-a' }, { id: 'user-b' }]);
  await db.insert(platformAgents).values({
    agentKey: 'support',
    currentVersionId: null,
    id: 'agent-support',
    migrationRequired: false,
    revision: 2,
    status: 'draft',
    title: 'Support',
  });
  await db.insert(platformAgentVersions).values([
    {
      agentId: 'agent-support',
      checksum: checksumPayload({ config: config('Support v1'), dependencySnapshot: dependencies }),
      config: config('Support v1'),
      dependencySnapshot: dependencies,
      id: 'version-1',
      version: '1.0.0',
    },
    {
      agentId: 'agent-support',
      checksum: checksumPayload({ config: config('Support v2'), dependencySnapshot: dependencies }),
      config: config('Support v2'),
      dependencySnapshot: dependencies,
      id: 'version-2',
      version: '2.0.0',
    },
  ]);
  await db
    .update(platformAgents)
    .set({ currentVersionId: 'version-2', publishedAt: new Date(), status: 'published' })
    .where(sql`${platformAgents.id} = 'agent-support'`);
  await db.insert(platformAgentAssignments).values({
    agentId: 'agent-support',
    enabled: true,
    id: 'assignment-global',
    mode: 'mandatory',
    pinnedVersionId: null,
    status: 'active',
    targetId: '__global__',
    targetType: 'global',
    versionPolicy: 'latest_published',
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await cleanup();
});

export const startInput = async () => {
  const [identity] = await db.select().from(platformAgents);
  return {
    agentId: identity.id,
    assignmentId: 'assignment-global',
    expectedDraftToken: platformAgentDraftToken(identity),
    expectedRevision: identity.revision,
    reason: 'approved rollout',
  };
};

export const exactChecksum = (name: string) =>
  checksumPayload({ config: config(name), dependencySnapshot: dependencies });

export const seedMaterializations = async (
  versions: Record<string, { checksum: string; versionId: string }> = Object.fromEntries(
    ['admin', 'user-a', 'user-b'].map((userId) => [
      userId,
      { checksum: exactChecksum('Support v1'), versionId: 'version-1' },
    ]),
  ),
) =>
  db.insert(platformUserAgentMaterializations).values(
    Object.entries(versions).map(([userId, version]) => ({
      lastSyncedAt: new Date(),
      platformAgentId: 'agent-support',
      platformAgentVersionChecksum: version.checksum,
      platformAgentVersionId: version.versionId,
      status: 'pending' as const,
      userId,
    })),
  );

export const publishV3 = async () => {
  await db.insert(platformAgentVersions).values({
    agentId: 'agent-support',
    checksum: exactChecksum('Support v3'),
    config: config('Support v3'),
    dependencySnapshot: dependencies,
    id: 'version-3',
    version: '3.0.0',
  });
  await db
    .update(platformAgents)
    .set({ currentVersionId: 'version-3', revision: 3 })
    .where(sql`${platformAgents.id} = 'agent-support'`);
};
