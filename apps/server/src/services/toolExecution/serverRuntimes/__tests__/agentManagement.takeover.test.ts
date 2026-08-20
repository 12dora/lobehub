/**
 * Builtin agent-management runtime under published enforced agent takeover.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MANAGED_ERROR_CODES } from '@/const/platform/errorCodes';
import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { agents, users } from '@/database/schemas';
import { platformManagedResourcePolicies } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

vi.mock('@/server/services/discover', () => ({
  DiscoverService: vi.fn(() => ({
    getAssistantList: vi.fn(async () => ({ items: [], totalCount: 0 })),
  })),
}));

const { agentManagementRuntime } = await import('../agentManagement');

let db: LobeChatDatabase;
const USER = 'runtime-takeover-user';

const publishAgentsTakeover = async () => {
  const model = new PlatformManagedResourcePolicyModel(db);
  await model.ensureRows();
  const policies = createUnmanagedResourcePolicyMap();
  policies.agents = { enforcementMode: 'enforced', managed: true };
  await model.materializePublished({ policies, revision: 1 });
};

beforeEach(async () => {
  db = await getTestDB();
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  await db.delete(platformManagedResourcePolicies);
  await db.delete(agents);
  await db.delete(users);
  await db.insert(users).values({ id: USER });
  await db.insert(agents).values({ id: 'agt_user', title: 'User owned', userId: USER });
});

afterEach(async () => {
  await db.delete(platformManagedResourcePolicies);
  await db.delete(agents);
  await db.delete(users);
  vi.unstubAllEnvs();
});

const runtime = () =>
  agentManagementRuntime.factory({
    serverDB: db,
    toolManifestMap: {},
    userId: USER,
  });

describe('agentManagementRuntime under takeover', () => {
  it('denies create/update/delete/duplicate against hidden local agents', async () => {
    await publishAgentsTakeover();
    const api = runtime();

    const created = await api.createAgent({ title: 'Nope' });
    expect(created.success).toBe(false);
    expect(created.content).toContain(MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM);

    const updated = await api.updateAgent({ agentId: 'agt_user', config: { title: 'x' } });
    expect(updated.success).toBe(false);
    expect(updated.content).toContain(MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM);

    const prompt = await api.updatePrompt({ agentId: 'agt_user', prompt: 'x' });
    expect(prompt.success).toBe(false);

    const duplicated = await api.duplicateAgent({ agentId: 'agt_user' });
    expect(duplicated.success).toBe(false);

    const removed = await api.deleteAgent({ agentId: 'agt_user' });
    expect(removed.success).toBe(false);

    const plugin = await api.installPlugin({ agentId: 'agt_user', identifier: 'web-browsing' });
    expect(plugin.success).toBe(false);
    expect(plugin.content).toContain(MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM);
  });

  it('denies getAgentDetail for a hidden local agent and allows the builtin inbox', async () => {
    await publishAgentsTakeover();
    const api = runtime();

    const hidden = await api.getAgentDetail({ agentId: 'agt_user' });
    expect(hidden.success).toBe(false);
    expect(hidden.content).toContain(MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM);

    const { AgentService } = await import('@/server/services/agent');
    const inbox = await new AgentService(db, USER).getBuiltinAgent('inbox');
    expect(inbox?.id).toBeTruthy();
    const inboxId = inbox?.id;
    expect(inboxId).toBeTruthy();
    const detail = await api.getAgentDetail({ agentId: inboxId as string });
    expect(detail.success).toBe(true);
    expect(detail.content).not.toContain(MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM);

    const search = await api.searchAgent({ source: 'user' });
    expect(search.success).toBe(true);
    const ids = ((search.state as { agents?: Array<{ id: string }> })?.agents ?? []).map(
      (agent) => agent.id,
    );
    expect(ids).not.toContain('agt_user');
    expect(ids).toContain(inboxId);
  });
});
