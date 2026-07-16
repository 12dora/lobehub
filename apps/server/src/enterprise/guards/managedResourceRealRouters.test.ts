// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import {
  agents,
  platformAuditLogs,
  platformManagedResourcePolicies,
  platformResourceRevisions,
  userConnectors,
  userConnectorTools,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';

import { agentRouter } from '../../routers/lambda/agent';
import { agentDocumentRouter } from '../../routers/lambda/agentDocument';
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

const {
  deleteConnectedAccount,
  getConnectedAccount,
  getRawComposioTools,
  initiateDeviceCode,
  linkConnectedAccount,
} = vi.hoisted(() => ({
  deleteConnectedAccount: vi.fn(async () => undefined),
  getConnectedAccount: vi.fn(async (id: string) => ({
    authConfig: { id: 'auth-gmail' },
    id,
    status: 'ACTIVE',
    toolkit: { slug: 'GMAIL' },
  })),
  getRawComposioTools: vi.fn(async () => ({
    items: [
      {
        description: 'trusted server tool',
        inputParameters: { type: 'object' },
        slug: 'GMAIL_TRUSTED_TOOL',
      },
    ],
  })),
  initiateDeviceCode: vi.fn(async () => ({
    deviceCode: 'device-code',
    expiresIn: 600,
    interval: 5,
    userCode: 'USER-CODE',
    verificationUri: 'https://example.com/device',
  })),
  linkConnectedAccount: vi.fn(async () => ({
    id: 'binding-gmail-1',
    redirectUrl: 'https://composio.example/link',
  })),
}));
vi.mock('@/config/composio', () => ({
  getServerComposioAuthConfigId: vi.fn(() => 'auth-gmail'),
}));
vi.mock('@/libs/composio', () => ({
  getComposioClient: () => ({
    authConfigs: { create: vi.fn(), list: vi.fn() },
    connectedAccounts: {
      delete: deleteConnectedAccount,
      get: getConnectedAccount,
      link: linkConnectedAccount,
    },
    tools: { getRawComposioTools },
  }),
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
  await db.insert(agents).values([
    { id: 'm06-ordinary-agent', slug: 'm06-ordinary-agent', userId: ordinary },
    { id: 'm06-super-agent', slug: 'm06-super-agent', userId: superAdmin },
  ]);
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
      () =>
        agentDocumentRouter.createCaller(context(ordinary)).createSkillByPath({
          agentId: 'm06-ordinary-agent',
          content: '# Managed skill',
          skillName: 'managed-skill',
          targetNamespace: 'agent',
        }),
      () =>
        agentDocumentRouter.createCaller(context(ordinary)).writeDocumentByPath({
          agentId: 'm06-ordinary-agent',
          content: '# Managed skill',
          path: './lobe/skills/agent/skills/managed-skill/SKILL.md',
        }),
      () =>
        agentDocumentRouter.createCaller(context(ordinary)).convertDocumentToSkill({
          agentId: 'm06-ordinary-agent',
          description: 'Managed skill',
          name: 'managed-skill',
          sourceAgentDocumentId: 'source-document',
          title: 'Managed skill',
        }),
      () =>
        agentDocumentRouter.createCaller(context(ordinary)).updateSkillByPath({
          agentId: 'm06-ordinary-agent',
          content: '# Updated',
          path: './lobe/skills/agent/skills/managed-skill/SKILL.md',
        }),
      () =>
        agentDocumentRouter.createCaller(context(ordinary)).deleteSkillByPath({
          agentId: 'm06-ordinary-agent',
          path: './lobe/skills/agent/skills/managed-skill/SKILL.md',
        }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'RESOURCE_MANAGED_BY_PLATFORM',
      });
    }
  });

  it('allows the owner-safe Composio connect, ACTIVE sync and reauthorize lifecycle', async () => {
    const caller = composioRouter.createCaller(context(ordinary));
    linkConnectedAccount.mockResolvedValueOnce({
      id: 'binding-gmail-1',
      redirectUrl: 'https://composio.example/link-1',
    });

    await expect(
      caller.createConnection({ appSlug: 'GMAIL', identifier: 'gmail', label: 'Gmail' }),
    ).resolves.toMatchObject({
      authConfigId: 'auth-gmail',
      connectedAccountId: 'binding-gmail-1',
      identifier: 'gmail',
    });
    await expect(
      caller.updateComposioPlugin({
        appSlug: 'GMAIL',
        authConfigId: 'auth-gmail',
        connectedAccountId: 'binding-gmail-1',
        identifier: 'gmail',
        label: 'Gmail',
        status: 'ACTIVE',
        tools: [
          {
            description: 'forged client tool',
            inputSchema: { endpoint: 'https://attacker.example' },
            name: 'FORGED_TOOL',
          },
        ],
      }),
    ).resolves.toEqual({ savedCount: 1 });

    const projection = (await db.select().from(userConnectors)).find(
      (row) => row.userId === ordinary && row.identifier === 'gmail',
    );
    expect(projection).toMatchObject({
      metadata: {
        composio: { connectedAccountId: 'binding-gmail-1', status: 'ACTIVE' },
      },
      name: 'Gmail',
      sourceType: 'marketplace',
      status: 'connected',
    });
    expect(
      (await db.select().from(userConnectorTools)).filter((row) => row.userId === ordinary),
    ).toEqual([
      expect.objectContaining({
        description: 'trusted server tool',
        toolName: 'GMAIL_TRUSTED_TOOL',
      }),
    ]);

    await expect(caller.deleteConnection({ identifier: 'gmail' })).resolves.toEqual({
      success: true,
    });
    linkConnectedAccount.mockResolvedValueOnce({
      id: 'binding-gmail-2',
      redirectUrl: 'https://composio.example/link-2',
    });
    await expect(
      caller.createConnection({ appSlug: 'GMAIL', identifier: 'gmail', label: 'Gmail' }),
    ).resolves.toMatchObject({ connectedAccountId: 'binding-gmail-2' });
  });

  it('rejects forged Composio targets and definition fields while uninstall stays denied', async () => {
    const caller = composioRouter.createCaller(context(ordinary));
    await db.insert(userConnectors).values({
      identifier: 'google-calendar',
      isEnabled: true,
      metadata: {
        composio: {
          appSlug: 'GOOGLECALENDAR',
          authConfigId: 'foreign-auth',
          connectedAccountId: 'foreign-google-binding',
          status: 'ACTIVE',
        },
      },
      name: 'Google Calendar',
      sourceType: 'marketplace',
      status: 'connected',
      userId: superAdmin,
    });
    const validUpdate = {
      appSlug: 'GMAIL' as const,
      authConfigId: 'auth-gmail',
      connectedAccountId: 'binding-gmail-2',
      identifier: 'gmail',
      label: 'Gmail',
      status: 'ACTIVE' as const,
      tools: [],
    };

    for (const call of [
      () => caller.createConnection({ appSlug: 'SLACK', identifier: 'gmail', label: 'Gmail' }),
      () =>
        caller.createConnection({
          appSlug: 'GMAIL',
          credential: 'attacker-secret',
          identifier: 'gmail',
          label: 'Gmail',
        } as never),
      () => caller.updateComposioPlugin({ ...validUpdate, connectedAccountId: 'foreign-binding' }),
      () =>
        caller.updateComposioPlugin({
          appSlug: 'GOOGLECALENDAR',
          authConfigId: 'foreign-auth',
          connectedAccountId: 'foreign-google-binding',
          identifier: 'google-calendar',
          label: 'Google Calendar',
          status: 'ACTIVE',
          tools: [],
        }),
      () =>
        caller.updateComposioPlugin({
          ...validUpdate,
          endpoint: 'https://attacker.example',
        } as never),
      () => caller.removeComposioPlugin({ identifier: 'gmail' }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'RESOURCE_MANAGED_BY_PLATFORM',
      });
    }

    expect(linkConnectedAccount).toHaveBeenCalledTimes(2);
  });

  it('does not let a real super_admin caller bypass an ordinary Provider router', async () => {
    await expect(
      aiProviderRouter.createCaller(context(superAdmin)).createAiProvider({
        id: 'super-provider',
        name: 'Super bypass',
        source: 'custom',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'RESOURCE_MANAGED_BY_PLATFORM' });
    await expect(
      agentDocumentRouter.createCaller(context(superAdmin)).createSkillByPath({
        agentId: 'm06-super-agent',
        content: '# Super skill',
        skillName: 'super-skill',
        targetNamespace: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'RESOURCE_MANAGED_BY_PLATFORM' });
  });

  it('allows ordinary VFS writes but denies every Skill source/target path transition', async () => {
    const caller = agentDocumentRouter.createCaller(context(ordinary));
    await expect(
      caller.writeDocumentByPath({
        agentId: 'm06-ordinary-agent',
        content: '# Ordinary',
        path: './ordinary.md',
      }),
    ).resolves.toMatchObject({ path: './ordinary.md' });
    await expect(
      caller.renameDocumentByPath({
        agentId: 'm06-ordinary-agent',
        fromPath: './ordinary.md',
        toPath: './renamed.md',
      }),
    ).resolves.toMatchObject({ path: './renamed.md' });

    const skillPath = './lobe/skills/agent/skills/blocked/SKILL.md';
    for (const call of [
      () =>
        caller.renameDocumentByPath({
          agentId: 'm06-ordinary-agent',
          fromPath: './renamed.md',
          toPath: skillPath,
        }),
      () =>
        caller.renameDocumentByPath({
          agentId: 'm06-ordinary-agent',
          fromPath: skillPath,
          toPath: './renamed.md',
        }),
      () =>
        caller.copyDocumentByPath({
          agentId: 'm06-ordinary-agent',
          fromPath: './renamed.md',
          toPath: skillPath,
        }),
      () =>
        caller.copyDocumentByPath({
          agentId: 'm06-ordinary-agent',
          fromPath: skillPath,
          toPath: './copied.md',
        }),
      () =>
        caller.deleteDocumentByPath({
          agentId: 'm06-ordinary-agent',
          path: skillPath,
        }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'RESOURCE_MANAGED_BY_PLATFORM',
      });
    }
  });

  it('allows exact Connector disconnect and owner-scoped OAuth/binding operations', async () => {
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
    const [composioConnector] = await db
      .insert(userConnectors)
      .values({
        identifier: 'owned-composio',
        isEnabled: true,
        metadata: {
          composio: {
            appSlug: 'github',
            authConfigId: 'owned-auth',
            connectedAccountId: 'trusted-owned-account',
            status: 'ACTIVE',
          },
        },
        name: 'Owned Composio',
        sourceType: 'marketplace',
        status: 'connected',
        userId: ordinary,
      })
      .returning();
    await expect(
      composioRouter.createCaller(context(ordinary)).deleteConnection({
        connectedAccountId: 'attacker-controlled-id-is-ignored',
        connectorId: composioConnector.id,
      }),
    ).resolves.toEqual({ success: true });
    expect(deleteConnectedAccount).toHaveBeenCalledWith('trusted-owned-account');
    await expect(
      oauthDeviceFlowRouter
        .createCaller(context(ordinary))
        .initiateDeviceCode({ providerId: 'githubcopilot' }),
    ).resolves.toMatchObject({ deviceCode: 'device-code', userCode: 'USER-CODE' });
  });

  it("rejects missing projections and another user's Composio binding without remote deletion", async () => {
    const [foreign] = await db
      .insert(userConnectors)
      .values({
        identifier: 'foreign-composio',
        isEnabled: true,
        metadata: {
          composio: {
            appSlug: 'slack',
            authConfigId: 'foreign-auth',
            connectedAccountId: 'foreign-binding',
            status: 'ACTIVE',
          },
        },
        name: 'Foreign Composio',
        sourceType: 'marketplace',
        status: 'connected',
        userId: superAdmin,
      })
      .returning();
    deleteConnectedAccount.mockClear();
    const caller = composioRouter.createCaller(context(ordinary));

    await expect(
      caller.deleteConnection({ connectorId: '00000000-0000-4000-8000-000000000001' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.deleteConnection({
        connectedAccountId: 'foreign-binding',
        connectorId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(deleteConnectedAccount).not.toHaveBeenCalled();
  });
});
