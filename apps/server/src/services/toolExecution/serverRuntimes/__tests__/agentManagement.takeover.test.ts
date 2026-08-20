/**
 * Builtin agent-management runtime under published enforced agent takeover.
 *
 * @vitest-environment node
 */
import { AgentManagementApiName } from '@lobechat/builtin-tool-agent-management';
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
const HIDDEN = 'agt_user';

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
  await db.insert(agents).values({ id: HIDDEN, title: 'User owned', userId: USER });
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

const invokeApi = (
  name: (typeof AgentManagementApiName)[keyof typeof AgentManagementApiName],
  api: ReturnType<typeof runtime>,
  subAgentRun: ReturnType<typeof vi.fn>,
) => {
  switch (name) {
    case AgentManagementApiName.callAgent: {
      return api.callAgent(
        { agentId: HIDDEN, instruction: 'do the thing' },
        { subAgent: { run: subAgentRun }, toolManifestMap: {} },
      );
    }
    case AgentManagementApiName.createAgent: {
      return api.createAgent({ title: 'Nope' });
    }
    case AgentManagementApiName.deleteAgent: {
      return api.deleteAgent({ agentId: HIDDEN });
    }
    case AgentManagementApiName.duplicateAgent: {
      return api.duplicateAgent({ agentId: HIDDEN });
    }
    case AgentManagementApiName.getAgentDetail: {
      return api.getAgentDetail({ agentId: HIDDEN });
    }
    case AgentManagementApiName.installPlugin: {
      return api.installPlugin({ agentId: HIDDEN, identifier: 'web-browsing' });
    }
    case AgentManagementApiName.searchAgent: {
      return api.searchAgent({ source: 'user' });
    }
    case AgentManagementApiName.updateAgent: {
      return api.updateAgent({ agentId: HIDDEN, config: { title: 'x' } });
    }
    case AgentManagementApiName.updatePrompt: {
      return api.updatePrompt({ agentId: HIDDEN, prompt: 'x' });
    }
    default: {
      const exhaustive: never = name;
      throw new Error(`unhandled API ${exhaustive}`);
    }
  }
};

describe('agentManagementRuntime under takeover', () => {
  it.each(Object.values(AgentManagementApiName))(
    '%s is denied before AgentModel / sub-agent I/O (searchAgent lists the replacement set)',
    async (name) => {
      await publishAgentsTakeover();
      const subAgentRun = vi.fn();
      const before = await db.select({ id: agents.id, title: agents.title }).from(agents);

      const result = await invokeApi(name, runtime(), subAgentRun);
      const after = await db.select({ id: agents.id, title: agents.title }).from(agents);

      if (name === AgentManagementApiName.searchAgent) {
        expect(result.success).toBe(true);
        expect(subAgentRun).not.toHaveBeenCalled();
        const ids = ((result.state as { agents?: Array<{ id: string }> })?.agents ?? []).map(
          (agent) => agent.id,
        );
        expect(ids).not.toContain(HIDDEN);
        return;
      }

      expect(result.success).toBe(false);
      expect(result.content).toContain(MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM);
      expect(after).toEqual(before);
      expect(subAgentRun).not.toHaveBeenCalled();
    },
  );

  it('allows the builtin inbox getAgentDetail under takeover', async () => {
    await publishAgentsTakeover();
    const api = runtime();

    const { AgentService } = await import('@/server/services/agent');
    const inbox = await new AgentService(db, USER).getBuiltinAgent('inbox');
    expect(inbox?.id).toBeTruthy();
    const inboxId = inbox?.id as string;
    const detail = await api.getAgentDetail({ agentId: inboxId });
    expect(detail.success).toBe(true);
    expect(detail.content).not.toContain(MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM);
  });
});
