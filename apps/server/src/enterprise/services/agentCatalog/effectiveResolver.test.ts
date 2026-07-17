import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import {
  createUnmanagedResourcePolicyMap,
  type ManagedResourcePolicySnapshot,
} from '@/database/models/platform';
import type {
  PlatformAgentCatalogRepository,
  PlatformAgentEffectiveInput,
} from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformAgentEffectiveResolver } from './effectiveResolver';

const config = {
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName: 'Support',
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Help users.',
  tags: [],
};

const flags = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true };
const managedPolicy = (): ManagedResourcePolicySnapshot => {
  const published = createUnmanagedResourcePolicyMap();
  published.agents = { enforcementMode: 'enforced', managed: true };
  return {
    draft: createUnmanagedResourcePolicyMap(),
    published,
    revision: 1,
    status: 'published',
  };
};

const row = (params: {
  agentId: string;
  agentKey: string;
  assignmentId: string;
  config?: typeof config;
  mode?: 'default' | 'mandatory' | 'optional';
  priority: 1 | 2 | 3;
  systemKey?: string | null;
  versionId?: string;
}): PlatformAgentEffectiveInput =>
  ({
    agent: {
      agentKey: params.agentKey,
      id: params.agentId,
      systemKey: params.systemKey ?? null,
    },
    assignment: {
      id: params.assignmentId,
      mode: params.mode ?? 'optional',
    },
    targetPriority: params.priority,
    version: {
      checksum: 'a'.repeat(64),
      config: params.config ?? config,
      id: params.versionId ?? `${params.agentId}-version`,
      version: '1.0.0',
    },
  }) as unknown as PlatformAgentEffectiveInput;

const db = {} as LobeChatDatabase;

describe('PlatformAgentEffectiveResolver', () => {
  const getSnapshot = vi.fn();
  const listEffectiveInputs = vi.fn();
  const listHiddenPlatformAgentIds = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getSnapshot.mockResolvedValue(managedPolicy());
    listEffectiveInputs.mockResolvedValue([]);
    listHiddenPlatformAgentIds.mockResolvedValue(new Set<string>());
  });

  const createResolver = (enabledFlags = flags) =>
    new PlatformAgentEffectiveResolver(db, {
      flags: enabledFlags,
      policyModel: { getSnapshot },
      repository: {
        listEffectiveInputs,
        listHiddenPlatformAgentIds,
      } as Pick<
        PlatformAgentCatalogRepository,
        'listEffectiveInputs' | 'listHiddenPlatformAgentIds'
      >,
    });

  it('does not read policy, Agent, or hidden tables while the feature is disabled', async () => {
    const result = await createResolver(DEFAULT_ENTERPRISE_FEATURE_FLAGS).getEffectiveList('user');
    expect(result.agents).toEqual([]);
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(listEffectiveInputs).not.toHaveBeenCalled();
    expect(listHiddenPlatformAgentIds).not.toHaveBeenCalled();
  });

  it('does not read Agent or hidden tables while the published policy is unmanaged', async () => {
    getSnapshot.mockResolvedValue({
      ...managedPolicy(),
      published: createUnmanagedResourcePolicyMap(),
    });
    expect((await createResolver().getEffectiveList('user')).agents).toEqual([]);
    expect(listEffectiveInputs).not.toHaveBeenCalled();
    expect(listHiddenPlatformAgentIds).not.toHaveBeenCalled();
  });

  it('applies user > global role > global priority and de-duplicates Agent/system keys', async () => {
    listEffectiveInputs.mockResolvedValue([
      row({ agentId: 'same', agentKey: 'same', assignmentId: 'global', priority: 1 }),
      row({
        agentId: 'inbox-low',
        agentKey: 'inbox-low',
        assignmentId: 'role',
        priority: 2,
        systemKey: 'default-inbox',
      }),
      row({
        agentId: 'inbox-high',
        agentKey: 'inbox-high',
        assignmentId: 'user',
        mode: 'mandatory',
        priority: 3,
        systemKey: 'default-inbox',
      }),
      row({
        agentId: 'same',
        agentKey: 'same',
        assignmentId: 'user-same',
        mode: 'default',
        priority: 3,
        versionId: 'same-user-version',
      }),
    ]);

    const result = await createResolver().getEffectiveList('user');
    expect(result.agents).toHaveLength(2);
    expect(result.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          distribution: 'mandatory',
          platformAgentId: 'inbox-high',
          systemKey: 'default-inbox',
        }),
        expect.objectContaining({
          distribution: 'default',
          platformAgentId: 'same',
          versionId: 'same-user-version',
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('targetId');
    expect(JSON.stringify(result)).not.toContain('dependencySnapshot');
  });

  it('returns only an Agent assigned to the requesting user', async () => {
    listEffectiveInputs.mockResolvedValue([
      row({ agentId: 'visible', agentKey: 'visible', assignmentId: 'global', priority: 1 }),
    ]);
    await expect(createResolver().getEffectiveAgent('user', 'visible')).resolves.toMatchObject({
      platformAgentId: 'visible',
    });
    await expect(createResolver().getEffectiveAgent('user', 'missing')).resolves.toBeNull();
  });

  // R1: mandatory ignores hidden; default / optional respect the requesting user's hidden set.
  describe('owner-scoped hidden filtering (R1)', () => {
    beforeEach(() => {
      listEffectiveInputs.mockResolvedValue([
        row({
          agentId: 'mand',
          agentKey: 'mand',
          assignmentId: 'a1',
          mode: 'mandatory',
          priority: 3,
        }),
        row({ agentId: 'def', agentKey: 'def', assignmentId: 'a2', mode: 'default', priority: 3 }),
        row({ agentId: 'opt', agentKey: 'opt', assignmentId: 'a3', mode: 'optional', priority: 3 }),
      ]);
    });

    it('keeps every Agent visible when nothing is hidden', async () => {
      const result = await createResolver().getEffectiveList('user');
      expect(result.agents.map((agent) => agent.platformAgentId).sort()).toEqual([
        'def',
        'mand',
        'opt',
      ]);
    });

    it('hides default / optional but never mandatory', async () => {
      listHiddenPlatformAgentIds.mockResolvedValue(new Set(['mand', 'def', 'opt']));
      const result = await createResolver().getEffectiveList('user');
      expect(result.agents.map((agent) => agent.platformAgentId)).toEqual(['mand']);
    });

    it('reads the hidden set strictly for the requesting user', async () => {
      await createResolver().getEffectiveList('user-a');
      expect(listHiddenPlatformAgentIds).toHaveBeenCalledWith('user-a');
    });
  });

  // R2: operation snapshot is copy-safe and pins the exact version captured at call time.
  describe('operation snapshot (R2)', () => {
    it('returns a deep-frozen snapshot that a caller cannot mutate or pollute', async () => {
      listEffectiveInputs.mockResolvedValue([
        row({ agentId: 'snap', agentKey: 'snap', assignmentId: 'a', priority: 1 }),
      ]);
      const snapshot = await createResolver().resolveOperationSnapshot('user', 'snap');
      expect(snapshot).toMatchObject({
        checksum: 'a'.repeat(64),
        platformAgentId: 'snap',
        versionId: 'snap-version',
      });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot!.config)).toBe(true);
      // Deep clone: mutating the source config does not change the captured snapshot.
      expect(snapshot!.config).not.toBe(config);
      expect(() => {
        (snapshot!.config as { displayName: string }).displayName = 'tampered';
      }).toThrow();
      expect(snapshot!.config.displayName).toBe('Support');
      expect(JSON.stringify(snapshot)).not.toContain('dependencySnapshot');
    });

    it('pins the version captured when the operation started even after a new publish', async () => {
      listEffectiveInputs.mockResolvedValue([
        row({ agentId: 'ver', agentKey: 'ver', assignmentId: 'a', priority: 1, versionId: 'v1' }),
      ]);
      const resolver = createResolver();
      const operationA = await resolver.resolveOperationSnapshot('user', 'ver');

      // Publish v2 (the current pointer now resolves to a new version).
      listEffectiveInputs.mockResolvedValue([
        row({ agentId: 'ver', agentKey: 'ver', assignmentId: 'a', priority: 1, versionId: 'v2' }),
      ]);
      const operationB = await resolver.resolveOperationSnapshot('user', 'ver');

      expect(operationA?.versionId).toBe('v1'); // held snapshot unchanged by the new publish
      expect(operationB?.versionId).toBe('v2'); // a fresh operation captures the new version
    });

    it('returns null for an Agent the user is not entitled to', async () => {
      listEffectiveInputs.mockResolvedValue([]);
      expect(await createResolver().resolveOperationSnapshot('user', 'nope')).toBeNull();
    });
  });
});
