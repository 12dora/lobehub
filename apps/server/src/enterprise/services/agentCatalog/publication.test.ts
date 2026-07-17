import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase, Transaction } from '@/database/type';

import { PlatformAgentRevisionConflictError } from './errors';
import { platformAgentDraftToken, PlatformAgentPublicationService } from './publication';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  appendAudit: vi.fn(),
  assertDependencies: vi.fn(),
  getExactVersion: vi.fn(),
  lockIdentity: vi.fn(),
  pointToVersionCas: vi.fn(),
}));

vi.mock('@/database/repositories/platformAgentCatalog', () => ({
  PlatformAgentCatalogRepository: class {
    getExactVersion = mocks.getExactVersion;
    lockIdentity = mocks.lockIdentity;
    pointToVersionCas = mocks.pointToVersionCas;
  },
}));
vi.mock('../platformAudit', () => ({
  PlatformAuditService: class {
    append = mocks.appendAudit;
  },
}));
vi.mock('../platformDependencyLock', () => ({
  acquirePlatformDependencyPublicationLock: mocks.acquireLock,
}));
vi.mock('./dependencyValidator', () => ({
  assertExactPlatformAgentDependencies: mocks.assertDependencies,
}));

const identity = {
  agentKey: 'support',
  currentVersionId: null,
  draftSequence: 4,
  id: 'agent-id',
  isDefault: false,
  migrationRequired: false,
  revision: 0,
  status: 'draft',
  systemKey: null,
};
const dependencySnapshot = {
  connectors: [],
  model: {
    modelKey: 'chat',
    providerChecksum: 'a'.repeat(64),
    providerKey: 'provider',
    providerRevision: 1,
  },
  skills: [],
};
const input = {
  agentId: identity.id,
  expectedDraftToken: platformAgentDraftToken(identity),
  expectedRevision: 0,
  reason: 'publish approved draft',
  versionId: 'version-id',
};

const transaction = {} as Transaction;
const db = {
  transaction: vi.fn(async (operation: (tx: Transaction) => Promise<unknown>) =>
    operation(transaction),
  ),
} as unknown as LobeChatDatabase;

describe('PlatformAgentPublicationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lockIdentity.mockResolvedValue(identity);
    mocks.getExactVersion.mockResolvedValue({
      checksum: 'f'.repeat(64),
      dependencySnapshot,
      id: 'version-id',
      version: '1.0.0',
    });
    mocks.pointToVersionCas.mockResolvedValue({ revision: 1 });
  });

  it('locks, revalidates an existing version, points and audits before invalidation', async () => {
    const publish = vi.fn();
    const result = await new PlatformAgentPublicationService(db, {
      invalidation: { publish },
    }).publish('admin-id', input);

    expect(result).toEqual({ agentId: 'agent-id', revision: 1, versionId: 'version-id' });
    expect(mocks.lockIdentity).toHaveBeenCalledBefore(mocks.acquireLock);
    expect(mocks.acquireLock).toHaveBeenCalledBefore(mocks.assertDependencies);
    expect(mocks.getExactVersion).toHaveBeenCalledWith('agent-id', 'version-id');
    expect(mocks.pointToVersionCas).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDraftSequence: 4, expectedRevision: 0 }),
    );
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agents.publish', result: 'success' }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'agent-id', revision: 1 }),
    );
  });

  it('rolls back the transaction path on stale CAS and does not invalidate', async () => {
    const publish = vi.fn();
    mocks.lockIdentity.mockResolvedValue({ ...identity, draftSequence: 5 });
    await expect(
      new PlatformAgentPublicationService(db, { invalidation: { publish } }).publish(
        'admin-id',
        input,
      ),
    ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
    expect(mocks.getExactVersion).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agents.publish', result: 'failure' }),
    );
  });

  it('does not convert a committed publish into failure when invalidation throws', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('redis unavailable'));
    await expect(
      new PlatformAgentPublicationService(db, { invalidation: { publish } }).publish(
        'admin-id',
        input,
      ),
    ).resolves.toEqual({ agentId: 'agent-id', revision: 1, versionId: 'version-id' });
    expect(mocks.appendAudit).toHaveBeenCalledTimes(1);
  });
});
