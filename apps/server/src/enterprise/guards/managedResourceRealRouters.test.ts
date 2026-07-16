// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import {
  platformAuditLogs,
  platformManagedResourcePolicies,
  platformResourceRevisions,
  userConnectors,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';

import { agentRouter } from '../../routers/lambda/agent';
import { agentGroupRouter } from '../../routers/lambda/agentGroup';
import { agentSkillsRouter } from '../../routers/lambda/agentSkills';
import { aiModelRouter } from '../../routers/lambda/aiModel';
import { aiProviderRouter } from '../../routers/lambda/aiProvider';
import { composioRouter } from '../../routers/lambda/composio';
import { connectorRouter } from '../../routers/lambda/connector';
import { homeRouter } from '../../routers/lambda/home';
import { oauthDeviceFlowRouter } from '../../routers/lambda/oauthDeviceFlow';
import {
  clearManagedResourceReadinessForTest,
  registerManagedResourceReadiness,
} from '../services/managedResourceReadiness';

let db: LobeChatDatabase;

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));
vi.mock('@/server/globalConfig', () => ({
  getServerGlobalConfig: vi.fn(() => ({ aiProvider: {} })),
}));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: {
    getUserKeyVaults: vi.fn(),
    initWithEnvKey: vi.fn(async () => ({
      decrypt: async (value: string) => ({ plaintext: value }),
      encrypt: async (value: string) => value,
    })),
  },
}));
vi.mock('@/server/services/file', () => ({ FileService: vi.fn(() => ({})) }));

const { deleteConnectedAccount, initiateDeviceCode } = vi.hoisted(() => ({
  deleteConnectedAccount: vi.fn(async () => undefined),
  initiateDeviceCode: vi.fn(async () => ({
    deviceCode: 'device-code',
    expiresIn: 600,
    interval: 5,
    userCode: 'USER-CODE',
    verificationUri: 'https://example.com/device',
  })),
}));
vi.mock('@/libs/composio', () => ({
  getComposioClient: () => ({ connectedAccounts: { delete: deleteConnectedAccount } }),
}));

vi.mock('@/server/services/oauthDeviceFlow/providers/githubCopilot', () => ({
  GithubCopilotOAuthService: class {},
  getOAuthService: () => ({ initiateDeviceCode }),
}));

const ordinary = 'm06-real-ordinary';
const superAdmin = 'm06-real-super';
const context = (userId: string) => ({ serverDB: db, userId });

beforeAll(async () => {
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AI', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  db = await getTestDB();
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
  await db.delete(platformManagedResourcePolicies);
  await db.delete(users);
  await db.insert(users).values([{ id: ordinary }, { id: superAdmin }]);
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
    userId: ordinary,
  });
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
    userId: superAdmin,
  });
  const policies = createUnmanagedResourcePolicyMap();
  for (const resource of Object.keys(policies) as Array<keyof typeof policies>) {
    policies[resource] = { enforcementMode: 'enforced', managed: true };
    registerManagedResourceReadiness(resource, () => true);
  }
  const model = new PlatformManagedResourcePolicyModel(db);
  await model.ensureRows();
  await model.materializePublished({ policies, revision: 1 });
});

afterAll(async () => {
  clearManagedResourceReadinessForTest();
  vi.unstubAllEnvs();
  await db.delete(platformAuditLogs);
  await db.delete(platformResourceRevisions);
  await db.delete(platformManagedResourcePolicies);
  await db.delete(users);
});

describe('real legacy router callers under enforced policy', () => {
  it('denies representative writes across all registered definition surfaces', async () => {
    const calls = [
      () =>
        aiProviderRouter.createCaller(context(ordinary)).createAiProvider({
          id: 'custom-provider',
          name: 'Custom',
          source: 'custom',
        }),
      () =>
        aiModelRouter
          .createCaller(context(ordinary))
          .createAiModel({ id: 'custom-model', providerId: 'custom-provider' }),
      () =>
        agentSkillsRouter.createCaller(context(ordinary)).create({
          content: '# Skill',
          description: 'custom skill',
          name: 'Custom',
        }),
      () =>
        connectorRouter.createCaller(context(ordinary)).create({
          identifier: 'custom-connector',
          name: 'Custom',
          sourceType: 'custom',
        }),
      () =>
        connectorRouter
          .createCaller(context(ordinary))
          .syncBuiltinTool({ identifier: 'lobe-local-system' }),
      () =>
        connectorRouter
          .createCaller(context(ordinary))
          .syncPluginTools({ identifier: 'installed-plugin' }),
      () => agentRouter.createCaller(context(ordinary)).createAgent({}),
      () => agentGroupRouter.createCaller(context(ordinary)).createGroup({ title: 'Group' }),
      () =>
        composioRouter.createCaller(context(ordinary)).createConnection({
          appSlug: 'github',
          identifier: 'composio-github',
          label: 'GitHub',
        }),
      () =>
        homeRouter.createCaller(context(ordinary)).updateAgentSessionGroupId({
          agentId: 'agent-id',
          sessionGroupId: null,
        }),
      () =>
        oauthDeviceFlowRouter.createCaller(context(ordinary)).pollAuthStatus({
          deviceCode: 'device-code',
          providerId: 'githubcopilot',
        }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'RESOURCE_MANAGED_BY_PLATFORM',
      });
    }
  });

  it('does not let a real super_admin caller bypass an ordinary Provider router', async () => {
    await expect(
      aiProviderRouter.createCaller(context(superAdmin)).createAiProvider({
        id: 'super-provider',
        name: 'Super bypass',
        source: 'custom',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'RESOURCE_MANAGED_BY_PLATFORM' });
  });

  it('allows exact Connector disconnect and narrow OAuth/binding operations', async () => {
    const [connector] = await db
      .insert(userConnectors)
      .values({
        identifier: 'owned-connector',
        isEnabled: true,
        name: 'Owned',
        sourceType: 'custom',
        status: 'connected',
        userId: ordinary,
      })
      .returning();
    await expect(
      connectorRouter.createCaller(context(ordinary)).update({
        id: connector.id,
        patch: { isEnabled: false },
      }),
    ).resolves.toBeUndefined();
    await expect(
      composioRouter.createCaller(context(ordinary)).deleteConnection({
        connectedAccountId: 'owned-account',
        identifier: 'missing-projection-is-idempotent',
      }),
    ).resolves.toEqual({ success: true });
    await expect(
      oauthDeviceFlowRouter
        .createCaller(context(ordinary))
        .initiateDeviceCode({ providerId: 'githubcopilot' }),
    ).resolves.toMatchObject({ deviceCode: 'device-code', userCode: 'USER-CODE' });
  });
});
