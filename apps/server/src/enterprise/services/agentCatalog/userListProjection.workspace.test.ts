// @vitest-environment node
import { INBOX_SESSION_ID } from '@lobechat/const';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import { AgentModel } from '@/database/models/agent';
import { HomeRepository } from '@/database/repositories/home';
import type { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import { users, workspaces } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { AgentService } from '@/server/services/agent';

import type { PlatformAgentEffectiveResolver } from './effectiveResolver';
import { PlatformAgentUserListService } from './userListProjection';

const userId = 'managed-inbox-workspace-user';
let db: LobeChatDatabase;
let workspaceId: string;

const options = () => ({
  flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true },
  repository: {
    listMaterializedAgentIds: vi.fn(async () => new Set<string>()),
  } as unknown as PlatformAgentCatalogRepository,
  resolver: {
    getEffectiveList: vi.fn(async () => ({ agents: [], revision: 'empty' })),
  } as unknown as Pick<PlatformAgentEffectiveResolver, 'getEffectiveList'>,
});

beforeEach(async () => {
  db = await getTestDB();
  await db.insert(users).values({ id: userId });
  const [workspace] = await db
    .insert(workspaces)
    .values({ name: 'Managed Inbox Workspace', primaryOwnerId: userId, slug: 'managed-inbox-ws' })
    .returning();
  workspaceId = workspace.id;
});

afterEach(async () => {
  await db.delete(users);
  vi.unstubAllEnvs();
});

describe('PlatformAgentUserListService — real DB workspace scope', () => {
  it('keeps picker, sidebar, search, and runtime builtin identity in their own scope', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const personalModel = new AgentModel(db, userId);
    const workspaceModel = new AgentModel(db, userId, workspaceId);
    const personalHome = new HomeRepository(db, userId);
    const workspaceHome = new HomeRepository(db, userId, workspaceId);
    const personalList = new PlatformAgentUserListService(db, undefined, options());
    const workspaceList = new PlatformAgentUserListService(db, workspaceId, options());

    const personalPicker = await personalList.mergeAvailableAgents(
      userId,
      { limit: 20, offset: 0 },
      (params) => personalModel.queryAgents(params),
      () => personalModel.queryAgents(),
    );
    const workspacePicker = await workspaceList.mergeAvailableAgents(
      userId,
      { limit: 20, offset: 0 },
      (params) => workspaceModel.queryAgents(params),
      () => workspaceModel.queryAgents(),
    );
    const personalInboxId = personalPicker[0].id;
    const workspaceInboxId = workspacePicker[0].id;

    expect(personalInboxId).not.toBe(workspaceInboxId);
    expect(personalPicker.map(({ id }) => id)).toEqual([personalInboxId]);
    expect(workspacePicker.map(({ id }) => id)).toEqual([workspaceInboxId]);

    const personalSidebar = await personalList.mergeSidebarList(
      userId,
      await personalHome.getSidebarAgentList(),
    );
    const workspaceSidebar = await workspaceList.mergeSidebarList(
      userId,
      await workspaceHome.getSidebarAgentList(),
    );
    expect(personalSidebar.ungrouped.map(({ id }) => id)).toEqual([personalInboxId]);
    expect(workspaceSidebar.ungrouped.map(({ id }) => id)).toEqual([workspaceInboxId]);

    const personalSearch = await personalList.mergeSearchResults(
      userId,
      await personalHome.searchAgents(''),
      '',
    );
    const workspaceSearch = await workspaceList.mergeSearchResults(
      userId,
      await workspaceHome.searchAgents(''),
      '',
    );
    expect(personalSearch.map(({ id }) => id)).toEqual([personalInboxId]);
    expect(workspaceSearch.map(({ id }) => id)).toEqual([workspaceInboxId]);

    const workspaceRuntime = new AgentService(db, userId, workspaceId);
    const personalRuntime = new AgentService(db, userId);
    expect((await workspaceRuntime.getAgentConfigById(workspaceInboxId))?.slug).toBe(
      INBOX_SESSION_ID,
    );
    expect(await personalRuntime.getAgentConfigById(workspaceInboxId)).toBeNull();
    expect(await workspaceRuntime.getAgentConfigById(personalInboxId)).toBeNull();
  });
});
