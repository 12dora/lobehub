import { DEFAULT_AGENT_CONFIG, INBOX_SESSION_ID } from '@lobechat/const';
import { PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import type { LobeChatDatabase } from '@/database/type';
import type { AgentConfigWithId } from '@/server/services/agent';

import { PlatformDefaultInboxService } from './defaultInbox';
import type {
  PlatformAgentOperationHandle,
  PlatformAgentOperationSnapshot,
} from './effectiveResolver';

const flagsOn = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true };
const flagsOff = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: false };
const db = {} as LobeChatDatabase;

const dependencySnapshot = {
  connectors: [
    {
      allowedToolKeys: ['search.run'],
      connectorId: 'connector-1',
      connectorKey: 'managed-search',
      publishedChecksum: 'c'.repeat(64),
      publishedRevision: 2,
    },
  ],
  model: {
    modelKey: 'managed-model',
    providerChecksum: 'm'.repeat(64),
    providerKey: 'managed-provider',
    providerRevision: 3,
  },
  skills: [{ checksum: 's'.repeat(64), skillKey: 'managed-skill', version: '2.0.0' }],
};

const snapshot = (versionId: string, displayName = `Inbox ${versionId}`) =>
  ({
    checksum: versionId === 'v2' ? '2'.repeat(64) : '1'.repeat(64),
    config: {
      avatar: 'managed-avatar',
      backgroundColor: '#123456',
      description: 'Managed description',
      displayName,
      modelParameters: { temperature: 0.2 },
      openingMessage: 'Managed welcome',
      openingQuestions: ['Managed question'],
      systemRole: `Managed prompt ${versionId}`,
      tags: ['managed'],
    },
    platformAgentId: 'platform-default-inbox',
    versionId,
  }) satisfies PlatformAgentOperationSnapshot;

const handle = (value: PlatformAgentOperationSnapshot): PlatformAgentOperationHandle => ({
  distribution: 'mandatory',
  getSnapshot: () => value,
  platformAgentId: value.platformAgentId,
});

const base = (): AgentConfigWithId & {
  description?: string | null;
  slug: string;
  tags?: string[];
} => ({
  ...DEFAULT_AGENT_CONFIG,
  avatar: 'legacy-avatar',
  description: 'Legacy description',
  id: 'builtin-inbox-id',
  model: 'legacy-model',
  plugins: ['legacy-tool'],
  provider: 'legacy-provider',
  slug: INBOX_SESSION_ID,
  systemRole: 'Legacy prompt',
  tags: ['legacy'],
  title: 'Legacy inbox',
});

const resolvedConfig = (value: PlatformAgentOperationSnapshot) => ({
  ...base(),
  id: 'builtin-inbox-id',
  model: dependencySnapshot.model.modelKey,
  params: { temperature: value.config.modelParameters.temperature },
  platform: {
    managed: true as const,
    source: 'platform' as const,
  },
  plugins: [],
  provider: dependencySnapshot.model.providerKey,
  slug: null,
  systemRole: value.config.systemRole,
  title: value.config.displayName,
});

describe('PlatformDefaultInboxService', () => {
  it('returns the exact legacy object with zero platform IO while the flag is off', async () => {
    const beginSystemOperation = vi.fn();
    const resolveForExistingAgent = vi.fn();
    const legacy = base();
    const service = new PlatformDefaultInboxService(db, 'user', {
      flags: flagsOff,
      materializationService: { resolveForExistingAgent },
      resolver: { beginSystemOperation },
    });

    await expect(service.getEffectiveBuiltinConfig(legacy)).resolves.toBe(legacy);
    expect(beginSystemOperation).not.toHaveBeenCalled();
    expect(resolveForExistingAgent).not.toHaveBeenCalled();
  });

  it('falls back only for a genuinely absent published default', async () => {
    const legacy = base();
    const beginSystemOperation = vi.fn(async () => null);
    const service = new PlatformDefaultInboxService(db, 'user', {
      flags: flagsOn,
      resolver: { beginSystemOperation },
    });

    await expect(service.getEffectiveBuiltinConfig(legacy)).resolves.toBe(legacy);
    expect(beginSystemOperation).toHaveBeenCalledWith(
      'user',
      PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
    );
  });

  it('overlays every managed field while preserving the builtin id/slug and non-managed config', async () => {
    const captured = snapshot('v2');
    const validateDependencies = vi.fn(async () => ({ valid: true as const }));
    const resolveForExistingAgent = vi.fn(async () => ({
      agentId: 'builtin-inbox-id',
      config: resolvedConfig(captured),
      dependencySnapshot,
    }));
    const service = new PlatformDefaultInboxService(db, 'user', {
      flags: flagsOn,
      materializationService: { resolveForExistingAgent },
      resolver: { beginSystemOperation: vi.fn(async () => handle(captured)) },
      validateDependencies,
    });

    const result = await service.getEffectiveBuiltinConfig(base());
    expect(result).toMatchObject({
      avatar: 'managed-avatar',
      description: 'Managed description',
      id: 'builtin-inbox-id',
      model: 'managed-model',
      openingMessage: 'Managed welcome',
      openingQuestions: ['Managed question'],
      provider: 'managed-provider',
      slug: INBOX_SESSION_ID,
      systemRole: 'Managed prompt v2',
      tags: ['managed'],
      title: 'Inbox v2',
    });
    expect(result.plugins).toEqual([]);
    expect(result.platform).toEqual({
      distribution: 'mandatory',
      managed: true,
      source: 'platform',
    });
    expect(resolveForExistingAgent).toHaveBeenCalledWith(captured, 'builtin-inbox-id');
    expect(validateDependencies).toHaveBeenCalledWith(db, dependencySnapshot);
  });

  it('keeps a captured V2 result pinned after the published pointer rolls back to V1', async () => {
    const v2 = snapshot('v2');
    const v1 = snapshot('v1');
    const beginSystemOperation = vi
      .fn()
      .mockResolvedValueOnce(handle(v2))
      .mockResolvedValueOnce(handle(v1));
    const resolveForExistingAgent = vi.fn(async (value: PlatformAgentOperationSnapshot) => ({
      agentId: 'builtin-inbox-id',
      config: resolvedConfig(value),
      dependencySnapshot,
    }));
    const service = new PlatformDefaultInboxService(db, 'user', {
      flags: flagsOn,
      materializationService: { resolveForExistingAgent },
      resolver: { beginSystemOperation },
      validateDependencies: vi.fn(async () => ({ valid: true as const })),
    });

    const operationStartedOnV2 = await service.getEffectiveBuiltinConfig(base());
    const operationStartedAfterRollback = await service.getEffectiveBuiltinConfig(base());
    expect(operationStartedOnV2.systemRole).toBe('Managed prompt v2');
    expect(operationStartedAfterRollback.systemRole).toBe('Managed prompt v1');
  });

  it('treats managed avatar null as an authoritative clear', async () => {
    const baseSnapshot = snapshot('v2');
    const captured: PlatformAgentOperationSnapshot = {
      ...baseSnapshot,
      config: { ...baseSnapshot.config, avatar: null },
    };
    const service = new PlatformDefaultInboxService(db, 'user', {
      flags: flagsOn,
      materializationService: {
        resolveForExistingAgent: vi.fn(async () => ({
          agentId: 'builtin-inbox-id',
          config: resolvedConfig(captured),
          dependencySnapshot,
        })),
      },
      resolver: { beginSystemOperation: vi.fn(async () => handle(captured)) },
      validateDependencies: vi.fn(async () => ({ valid: true as const })),
    });

    expect((await service.getEffectiveBuiltinConfig(base())).avatar).toBeNull();
  });

  it('propagates resolver and exact dependency failures instead of treating errors as absence', async () => {
    const unavailable = new Error('stable resolver failure');
    const resolverFailure = new PlatformDefaultInboxService(db, 'user', {
      flags: flagsOn,
      resolver: {
        beginSystemOperation: vi.fn(async () => {
          throw unavailable;
        }),
      },
    });
    await expect(resolverFailure.getEffectiveBuiltinConfig(base())).rejects.toBe(unavailable);

    const exactFailure = new Error('exact dependency failure');
    const captured = snapshot('v2');
    const dependencyFailure = new PlatformDefaultInboxService(db, 'user', {
      flags: flagsOn,
      materializationService: {
        resolveForExistingAgent: vi.fn(async () => ({
          agentId: 'builtin-inbox-id',
          config: resolvedConfig(captured),
          dependencySnapshot,
        })),
      },
      resolver: { beginSystemOperation: vi.fn(async () => handle(captured)) },
      validateDependencies: vi.fn(async () => {
        throw exactFailure;
      }),
    });
    await expect(dependencyFailure.getEffectiveBuiltinConfig(base())).rejects.toBe(exactFailure);
  });
});
