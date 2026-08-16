// @vitest-environment node
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { MANAGED_ERROR_CODES } from '@/const/platform/errorCodes';
import {
  DISABLED_ENTERPRISE_FEATURE_FLAGS,
  type EnterpriseFeatureFlags,
} from '@/const/platform/featureFlags';
import {
  MANAGED_RESOURCE_KINDS,
  type ManagedResourceKind,
} from '@/const/platform/managedResources';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { aiProviders, platformAuditLogs, userRoles, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { trpc } from '@/libs/trpc/lambda/init';
import type { ManagedResourcePolicyItem } from '@/types/platform/managedResources';

import { InMemoryManagedResourceGuardMetricSink } from '../services/__test-support__/managedResourceGuardMetricSink';
import {
  clearManagedResourceReadinessForTest,
  registerManagedResourceReadiness,
} from '../services/managedResourceReadiness';
import { getEnterpriseErrorBody } from './enterpriseErrors';
import {
  enforceManagedResourceMutation,
  isConnectorDisconnectInput,
  isOrdinaryAgentDocumentPathInput,
  isOrdinaryAgentDocumentPathPairInput,
  withManagedResourceGuard,
} from './managedResource';
import type { ManagedResourceMutationProcedure } from './managedResourceMutationRegistry';

const serverDB: LobeChatDatabase = await getTestDB();
const legacySkillMutation = vi.fn(() => true);
const directProcedure = trpc.procedure.use(({ next }) => next({ ctx: { serverDB } }));
const directRouter = trpc.router({
  agentWrite: directProcedure
    .use(withManagedResourceGuard('agent.updateAgentConfig'))
    .mutation(() => true),
  connectorOAuth: directProcedure
    .use(withManagedResourceGuard('connector.startOAuth'))
    .mutation(() => true),
  connectorDisconnect: directProcedure
    .use(
      withManagedResourceGuard('connector.update', {
        isExemptInput: isConnectorDisconnectInput,
      }),
    )
    .input(z.object({ id: z.string().uuid(), patch: z.object({ isEnabled: z.boolean() }) }))
    .mutation(() => true),
  connectorDelete: directProcedure
    .use(withManagedResourceGuard('connector.delete'))
    .mutation(() => true),
  connectorWrite: directProcedure
    .use(withManagedResourceGuard('connector.update'))
    .mutation(() => true),
  modelWrite: directProcedure
    .use(withManagedResourceGuard('aiModel.updateAiModel'))
    .mutation(() => true),
  providerWrite: directProcedure
    .use(withManagedResourceGuard('aiProvider.createAiProvider'))
    .mutation(() => true),
  readAgent: directProcedure.query(() => true),
  skillWrite: directProcedure
    .use(withManagedResourceGuard('agentSkills.update'))
    .mutation(() => legacySkillMutation()),
});

const guardedProcedure: Record<ManagedResourceKind, ManagedResourceMutationProcedure> = {
  agents: 'agent.updateAgentConfig',
  aiModels: 'aiModel.updateAiModel',
  aiProviders: 'aiProvider.createAiProvider',
  connectors: 'connector.update',
  skills: 'agentSkills.update',
};

const readinessFor = (resource: ManagedResourceKind, ready: boolean) => async () => ({
  agents: resource === 'agents' ? ready : false,
  aiModels: resource === 'aiModels' ? ready : false,
  aiProviders: resource === 'aiProviders' ? ready : false,
  connectors: resource === 'connectors' ? ready : false,
  skills: resource === 'skills' ? ready : false,
});

const flagsFor = (resource: ManagedResourceKind, enabled: boolean): EnterpriseFeatureFlags => ({
  ...DISABLED_ENTERPRISE_FEATURE_FLAGS,
  ENABLE_PLATFORM_MANAGED_AGENTS: resource === 'agents' && enabled,
  ENABLE_PLATFORM_MANAGED_AI: (resource === 'aiModels' || resource === 'aiProviders') && enabled,
  ENABLE_PLATFORM_MANAGED_CONNECTORS: resource === 'connectors' && enabled,
  ENABLE_PLATFORM_MANAGED_SKILLS: resource === 'skills' && enabled,
});

const materialize = async (
  resource: ManagedResourceKind,
  item: ManagedResourcePolicyItem,
  revision = 1,
) => {
  const model = new PlatformManagedResourcePolicyModel(serverDB);
  await model.ensureRows();
  const policies = createUnmanagedResourcePolicyMap();
  policies[resource] = item;
  await model.materializePublished({ policies, revision });
};

/** Suite-owned principals — never wipe shared users/tables (SG-07). */
const FIXTURE_USER_IDS = [
  'sg07-mrg-actor-observe',
  'sg07-mrg-actor-outage',
  'sg07-mrg-actor-ready',
  'sg07-mrg-direct-user',
  'sg07-mrg-legacy-user',
  'sg07-mrg-ordinary-user',
  'sg07-mrg-super-admin',
] as const;

const clearFixtureAudits = async () => {
  await serverDB.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('lobe.allow_platform_audit_log_delete', 'on', true)`);
    // Scope only to this suite's fixture actors — never delete by action alone
    // (concurrent managedResourceRealRouters tests also emit managedResource.legacyMutation).
    await tx
      .delete(platformAuditLogs)
      .where(inArray(platformAuditLogs.actorUserId, [...FIXTURE_USER_IDS]));
  });
};

/** Scoped cleanup: fixture audits + fixture rows only. Policies are re-materialized per test. */
const clearGuardTables = async () => {
  await clearFixtureAudits();
  await serverDB.delete(aiProviders).where(inArray(aiProviders.userId, [...FIXTURE_USER_IDS]));
  await serverDB.delete(userRoles).where(inArray(userRoles.userId, [...FIXTURE_USER_IDS]));
  await serverDB.delete(users).where(inArray(users.id, [...FIXTURE_USER_IDS]));
};

beforeEach(async () => {
  vi.clearAllMocks();
  clearManagedResourceReadinessForTest();
  vi.unstubAllEnvs();
  await clearGuardTables();
});

afterEach(async () => {
  clearManagedResourceReadinessForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await clearGuardTables();
});

describe('ManagedResourceGuard policy matrix', () => {
  for (const resource of MANAGED_RESOURCE_KINDS) {
    it(`${resource}: flag off and managed=false restore legacy mutations`, async () => {
      await materialize(resource, { enforcementMode: 'enforced', managed: true });
      await expect(
        enforceManagedResourceMutation({
          db: serverDB,
          options: { flags: flagsFor(resource, false), readiness: readinessFor(resource, true) },
          procedure: guardedProcedure[resource],
        }),
      ).resolves.toBeUndefined();

      await materialize(resource, { enforcementMode: 'enforced', managed: false }, 2);
      await expect(
        enforceManagedResourceMutation({
          db: serverDB,
          options: { flags: flagsFor(resource, true), readiness: readinessFor(resource, true) },
          procedure: guardedProcedure[resource],
        }),
      ).resolves.toBeUndefined();
    });

    it(`${resource}: observe and ui-only allow while recording sanitized would-deny`, async () => {
      for (const mode of ['observe', 'ui-only'] as const) {
        await clearFixtureAudits();
        await materialize(resource, { enforcementMode: mode, managed: true });
        const sink = new InMemoryManagedResourceGuardMetricSink();
        await expect(
          enforceManagedResourceMutation({
            db: serverDB,
            options: {
              flags: flagsFor(resource, true),
              metricSink: sink,
              readiness: readinessFor(resource, false),
            },
            principal: { userId: 'sg07-mrg-actor-observe' },
            procedure: guardedProcedure[resource],
          }),
        ).resolves.toBeUndefined();

        expect(Object.values(sink.snapshot())).toEqual([1]);
        const audits = await serverDB
          .select()
          .from(platformAuditLogs)
          .where(eq(platformAuditLogs.actorUserId, 'sg07-mrg-actor-observe'));
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          action: 'managedResource.legacyMutation',
          actorUserId: 'sg07-mrg-actor-observe',
          reason: null,
          result: 'failure',
          targetId: guardedProcedure[resource],
          targetType: 'managed_policy',
        });
        expect(audits[0]?.afterDiff).toMatchObject({ outcome: 'would_deny' });
        expect(JSON.stringify(audits)).not.toMatch(/credential|payload|secret|token|password/i);
      }
    });

    it(`${resource}: enforced fails closed on catalog outage and denies when ready`, async () => {
      await materialize(resource, { enforcementMode: 'enforced', managed: true });
      const sink = new InMemoryManagedResourceGuardMetricSink();
      const catalogOutageDecision = () =>
        enforceManagedResourceMutation({
          db: serverDB,
          options: {
            flags: flagsFor(resource, true),
            metricSink: sink,
            readiness: readinessFor(resource, false),
          },
          principal: { userId: 'sg07-mrg-actor-outage' },
          procedure: guardedProcedure[resource],
        });

      await expect(catalogOutageDecision()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
      });
      // Skills and the AI catalog (aiProviders/aiModels) keep effective mode enforced during a
      // catalog outage — their runtimes fail closed and the server takeover predicate reads the
      // published policy, so the client must keep the UI blocked (metric outcome "denied").
      // The remaining resources degrade UI mode to unmanaged but still deny with
      // catalog_not_ready.
      const outageKey = Object.keys(sink.snapshot())[0] ?? '';
      if (resource === 'skills' || resource === 'aiProviders' || resource === 'aiModels') {
        expect(outageKey).toContain('denied');
      } else {
        expect(outageKey).toContain('catalog_not_ready');
      }
      const outageAudits = await serverDB
        .select()
        .from(platformAuditLogs)
        .where(eq(platformAuditLogs.actorUserId, 'sg07-mrg-actor-outage'));
      expect(outageAudits.at(-1)).toMatchObject({
        actorUserId: 'sg07-mrg-actor-outage',
        result: 'denied',
        targetId: guardedProcedure[resource],
      });

      try {
        await enforceManagedResourceMutation({
          db: serverDB,
          options: {
            flags: flagsFor(resource, true),
            metricSink: sink,
            readiness: readinessFor(resource, true),
          },
          principal: { userId: 'sg07-mrg-actor-ready' },
          procedure: guardedProcedure[resource],
        });
        expect.unreachable('enforced mutation should be denied');
      } catch (error) {
        expect((error as { code: string }).code).toBe('FORBIDDEN');
        expect(getEnterpriseErrorBody(error)?.code).toBe(
          MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
        );
      }
    });
  }
});

describe('ManagedResourceGuard catalog outage regression', () => {
  it('fails closed before invoking a legacy Skill mutation', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
    await materialize('skills', { enforcementMode: 'enforced', managed: true });
    registerManagedResourceReadiness('skills', () => false);
    const caller = directRouter.createCaller({ userId: 'sg07-mrg-direct-user' });

    try {
      await caller.skillWrite();
      expect.unreachable('managed Skill catalog outage must reject the legacy mutation');
    } catch (error) {
      expect((error as { code: string }).code).toBe('FORBIDDEN');
      expect(getEnterpriseErrorBody(error)?.code).toBe(
        MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
      );
    }

    expect(legacySkillMutation).not.toHaveBeenCalled();
    expect(
      await serverDB
        .select()
        .from(platformAuditLogs)
        .where(eq(platformAuditLogs.actorUserId, 'sg07-mrg-direct-user')),
    ).toEqual([
      expect.objectContaining({
        action: 'managedResource.legacyMutation',
        actorUserId: 'sg07-mrg-direct-user',
        result: 'denied',
        targetId: 'agentSkills.update',
        targetType: 'managed_policy',
      }),
    ]);
  });
});

describe('ManagedResourceGuard compatibility and bypass resistance', () => {
  it('direct tRPC mutation calls deny all five resources while reads and OAuth remain usable', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AI', '1');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_CONNECTORS', '1');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    const policies = createUnmanagedResourcePolicyMap();
    for (const resource of MANAGED_RESOURCE_KINDS) {
      policies[resource] = { enforcementMode: 'enforced', managed: true };
      registerManagedResourceReadiness(resource, () => true);
    }
    const model = new PlatformManagedResourcePolicyModel(serverDB);
    await model.ensureRows();
    await model.materializePublished({ policies, revision: 1 });
    const caller = directRouter.createCaller({ userId: 'sg07-mrg-direct-user' });

    for (const call of [
      () => caller.agentWrite(),
      () => caller.connectorDelete(),
      () => caller.connectorWrite(),
      () => caller.modelWrite(),
      () => caller.providerWrite(),
      () => caller.skillWrite(),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
      });
    }
    await expect(caller.readAgent()).resolves.toBe(true);
    await expect(caller.connectorOAuth()).resolves.toBe(true);
    await expect(
      caller.connectorDisconnect({
        id: '00000000-0000-0000-0000-000000000001',
        patch: { isEnabled: false },
      }),
    ).resolves.toBe(true);
    const audits = await serverDB
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.actorUserId, 'sg07-mrg-direct-user'));
    expect(audits).toHaveLength(6);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: 'sg07-mrg-direct-user',
          reason: null,
          result: 'denied',
          targetId: 'connector.delete',
          targetType: 'managed_policy',
        }),
      ]),
    );
  });

  it('connector disconnect exemption is exact and cannot carry configuration edits', () => {
    const id = '00000000-0000-0000-0000-000000000001';
    expect(isConnectorDisconnectInput({ id, patch: { isEnabled: false } })).toBe(true);
    expect(isConnectorDisconnectInput({ id, patch: { isEnabled: true } })).toBe(false);
    expect(isConnectorDisconnectInput({ id, patch: { isEnabled: false, name: 'bypass' } })).toBe(
      false,
    );
    expect(
      isConnectorDisconnectInput({
        id,
        patch: { credentials: { token: 'not-logged', type: 'bearer' }, isEnabled: false },
      }),
    ).toBe(false);
  });

  it('agent-document path exemptions allow only unambiguous ordinary paths', () => {
    expect(isOrdinaryAgentDocumentPathInput({ path: './notes/design.md' })).toBe(true);
    expect(isOrdinaryAgentDocumentPathInput({ path: '/documents/design.md' })).toBe(true);
    expect(
      isOrdinaryAgentDocumentPathInput({
        path: 'lobe//skills/agent/skills/reviewer/SKILL.md',
      }),
    ).toBe(false);
    expect(isOrdinaryAgentDocumentPathInput({ path: './lobe/skills' })).toBe(false);
    expect(isOrdinaryAgentDocumentPathInput({})).toBe(false);
    expect(isOrdinaryAgentDocumentPathInput({ path: '' })).toBe(false);
    expect(isOrdinaryAgentDocumentPathInput({ path: './notes/../skills' })).toBe(false);
    expect(isOrdinaryAgentDocumentPathInput({ path: '.\\lobe\\skills\\agent' })).toBe(false);

    expect(
      isOrdinaryAgentDocumentPathPairInput({
        fromPath: './notes/a.md',
        toPath: './archive/a.md',
      }),
    ).toBe(true);
    expect(
      isOrdinaryAgentDocumentPathPairInput({
        fromPath: './lobe/skills/agent/skills/a/SKILL.md',
        toPath: './archive/a.md',
      }),
    ).toBe(false);
    expect(
      isOrdinaryAgentDocumentPathPairInput({
        fromPath: './notes/a.md',
        toPath: './lobe/skills/agent/skills/a/SKILL.md',
      }),
    ).toBe(false);
    expect(isOrdinaryAgentDocumentPathPairInput({ fromPath: './notes/a.md' })).toBe(false);
  });

  it('feature flag off is exact legacy behavior and does not read policy or readiness', async () => {
    const resolvePolicies = vi.fn(async () => {
      throw new Error('policy must not be read');
    });
    const readiness = vi.fn(async () => {
      throw new Error('readiness must not be read');
    });
    const isExemptInput = vi.fn(() => {
      throw new Error('input must not be classified');
    });
    await expect(
      enforceManagedResourceMutation({
        db: serverDB,
        options: {
          flags: flagsFor('aiProviders', false),
          readiness,
          resolvePolicies,
        },
        isExemptInput,
        procedure: 'aiProvider.createAiProvider',
      }),
    ).resolves.toBeUndefined();
    expect(resolvePolicies).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
    expect(isExemptInput).not.toHaveBeenCalled();
  });

  it('Composio binding lifecycle honors flag-off, observe and narrow enforced exemptions', async () => {
    const procedures = [
      'composio.createConnection',
      'composio.updateComposioPlugin',
    ] as const satisfies readonly ManagedResourceMutationProcedure[];
    const flagOffPredicate = vi.fn(() => {
      throw new Error('flag-off must not classify binding input');
    });
    for (const procedure of procedures) {
      await expect(
        enforceManagedResourceMutation({
          db: serverDB,
          isExemptInput: flagOffPredicate,
          options: { flags: flagsFor('connectors', false) },
          procedure,
        }),
      ).resolves.toBeUndefined();
    }
    expect(flagOffPredicate).not.toHaveBeenCalled();

    await materialize('connectors', { enforcementMode: 'observe', managed: true });
    for (const procedure of procedures) {
      await expect(
        enforceManagedResourceMutation({
          db: serverDB,
          isExemptInput: () => false,
          options: {
            flags: flagsFor('connectors', true),
            readiness: readinessFor('connectors', true),
          },
          procedure,
        }),
      ).resolves.toBeUndefined();
    }

    await materialize('connectors', { enforcementMode: 'enforced', managed: true }, 2);
    for (const procedure of procedures) {
      await expect(
        enforceManagedResourceMutation({
          db: serverDB,
          isExemptInput: () => true,
          options: {
            flags: flagsFor('connectors', true),
            readiness: readinessFor('connectors', true),
          },
          procedure,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('draft never takes effect, and publishing managed=false restores mutations without data loss', async () => {
    await serverDB.insert(users).values({ id: 'sg07-mrg-legacy-user' });
    await serverDB.insert(aiProviders).values({
      id: 'legacy-provider',
      name: 'Legacy provider',
      userId: 'sg07-mrg-legacy-user',
    });
    const model = new PlatformManagedResourcePolicyModel(serverDB);
    await model.ensureRows();
    const draft = createUnmanagedResourcePolicyMap();
    draft.aiProviders = { enforcementMode: 'enforced', managed: true };
    await model.replaceDraft({ draft });

    const options = {
      flags: flagsFor('aiProviders', true),
      readiness: readinessFor('aiProviders', true),
    };
    await expect(
      enforceManagedResourceMutation({
        db: serverDB,
        options,
        procedure: 'aiProvider.createAiProvider',
      }),
    ).resolves.toBeUndefined();

    await model.materializePublished({ policies: draft, revision: 1 });
    await expect(
      enforceManagedResourceMutation({
        db: serverDB,
        options,
        procedure: 'aiProvider.createAiProvider',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const rolledBack = createUnmanagedResourcePolicyMap();
    await model.materializePublished({ policies: rolledBack, revision: 2 });
    await expect(
      enforceManagedResourceMutation({
        db: serverDB,
        options,
        procedure: 'aiProvider.createAiProvider',
      }),
    ).resolves.toBeUndefined();
    expect(
      await serverDB
        .select()
        .from(aiProviders)
        .where(eq(aiProviders.userId, 'sg07-mrg-legacy-user')),
    ).toContainEqual(
      expect.objectContaining({ id: 'legacy-provider', userId: 'sg07-mrg-legacy-user' }),
    );
  });

  it('ordinary and super-admin principals receive the same denial for all five resources', async () => {
    await serverDB
      .insert(users)
      .values([{ id: 'sg07-mrg-ordinary-user' }, { id: 'sg07-mrg-super-admin' }]);
    await seedPlatformRoles(serverDB);
    await assignGlobalPlatformRole(serverDB, {
      roleName: PLATFORM_SYSTEM_ROLES.PLATFORM_USER,
      userId: 'sg07-mrg-ordinary-user',
    });
    await assignGlobalPlatformRole(serverDB, {
      roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
      userId: 'sg07-mrg-super-admin',
    });
    let revision = 1;
    for (const resource of MANAGED_RESOURCE_KINDS) {
      await materialize(resource, { enforcementMode: 'enforced', managed: true }, revision++);
      const options = {
        flags: flagsFor(resource, true),
        readiness: readinessFor(resource, true),
      };
      for (const userId of ['sg07-mrg-ordinary-user', 'sg07-mrg-super-admin']) {
        await expect(
          enforceManagedResourceMutation({
            db: serverDB,
            options,
            principal: { userId },
            procedure: guardedProcedure[resource],
          }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    }
  });

  it('OAuth/disconnect/tool-call/permission and agent-use helpers remain exempt when enforced', async () => {
    const preserved: ManagedResourceMutationProcedure[] = [
      'connector.startOAuth',
      'connector.callTool',
      'connector.resetPermissions',
      'connector.updateToolPermission',
      'agent.updateAgentPinned',
      'agent.acquireAgentLock',
      'agent.releaseAgentLock',
      'aiProvider.checkProviderConnectivity',
    ];
    for (const procedure of preserved) {
      await expect(
        enforceManagedResourceMutation({
          db: serverDB,
          options: {
            resolvePolicies: async () => {
              throw new Error('allow/exempt must not resolve policy');
            },
          },
          procedure,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('audit failure is best-effort: observe allows and enforced still denies', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const auditAppend = async () => {
      throw new Error('audit unavailable');
    };
    await materialize('skills', { enforcementMode: 'observe', managed: true });
    const common = {
      auditAppend,
      flags: flagsFor('skills', true),
      readiness: readinessFor('skills', true),
    };
    await expect(
      enforceManagedResourceMutation({
        db: serverDB,
        options: common,
        procedure: 'agentSkills.update',
      }),
    ).resolves.toBeUndefined();

    await materialize('skills', { enforcementMode: 'enforced', managed: true }, 2);
    await expect(
      enforceManagedResourceMutation({
        db: serverDB,
        options: common,
        procedure: 'agentSkills.update',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it('metric failure is best-effort: observe allows and enforced still denies', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const metricSink = {
      increment: () => {
        throw new Error('metric backend unavailable');
      },
    };
    await materialize('connectors', { enforcementMode: 'observe', managed: true });
    const common = {
      flags: flagsFor('connectors', true),
      metricSink,
      readiness: readinessFor('connectors', true),
    };
    await expect(
      enforceManagedResourceMutation({
        db: serverDB,
        options: common,
        procedure: 'connector.update',
      }),
    ).resolves.toBeUndefined();

    await materialize('connectors', { enforcementMode: 'enforced', managed: true }, 2);
    await expect(
      enforceManagedResourceMutation({
        db: serverDB,
        options: common,
        procedure: 'connector.update',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(consoleError).toHaveBeenCalledTimes(2);
  });
});
