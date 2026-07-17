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
      config,
      id: params.versionId ?? `${params.agentId}-version`,
      version: '1.0.0',
    },
  }) as unknown as PlatformAgentEffectiveInput;

const db = {} as LobeChatDatabase;

describe('PlatformAgentEffectiveResolver', () => {
  const getSnapshot = vi.fn();
  const listEffectiveInputs = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getSnapshot.mockResolvedValue(managedPolicy());
    listEffectiveInputs.mockResolvedValue([]);
  });

  const createResolver = (enabledFlags = flags) =>
    new PlatformAgentEffectiveResolver(db, {
      flags: enabledFlags,
      policyModel: { getSnapshot },
      repository: {
        listEffectiveInputs,
      } as Pick<PlatformAgentCatalogRepository, 'listEffectiveInputs'>,
    });

  it('does not read policy or Agent tables while the feature is disabled', async () => {
    const result = await createResolver(DEFAULT_ENTERPRISE_FEATURE_FLAGS).getEffectiveList('user');
    expect(result.agents).toEqual([]);
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(listEffectiveInputs).not.toHaveBeenCalled();
  });

  it('does not read Agent tables while the published policy is unmanaged', async () => {
    getSnapshot.mockResolvedValue({
      ...managedPolicy(),
      published: createUnmanagedResourcePolicyMap(),
    });
    expect((await createResolver().getEffectiveList('user')).agents).toEqual([]);
    expect(listEffectiveInputs).not.toHaveBeenCalled();
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
});
