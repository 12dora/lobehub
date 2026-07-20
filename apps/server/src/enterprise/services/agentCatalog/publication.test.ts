import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { EnterpriseObservabilityEvent } from '../../observability';
import { setEnterprisePlatformObserverForTest } from '../../observability';
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
const observed: EnterpriseObservabilityEvent[] = [];

describe('PlatformAgentPublicationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observed.length = 0;
    setEnterprisePlatformObserverForTest({ record: (event) => observed.push(event) });
    mocks.assertDependencies.mockResolvedValue(undefined);
    mocks.lockIdentity.mockResolvedValue(identity);
    mocks.getExactVersion.mockResolvedValue({
      checksum: 'f'.repeat(64),
      dependencySnapshot,
      id: 'version-id',
      version: '1.0.0',
    });
    mocks.pointToVersionCas.mockResolvedValue({ revision: 1 });
  });

  afterEach(() => setEnterprisePlatformObserverForTest(null));

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
    expect(observed).toEqual([
      {
        domain: 'agent_catalog',
        durationMs: expect.any(Number),
        operation: 'publish',
        outcome: 'success',
        type: 'config_publish',
      },
    ]);
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
    expect(observed).toEqual([
      {
        domain: 'agent_catalog',
        durationMs: expect.any(Number),
        errorClass: 'ConflictError',
        operation: 'publish',
        outcome: 'conflict',
        type: 'config_publish',
      },
    ]);
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
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ outcome: 'success' });
  });

  it('records rollback and keeps the event low-cardinality', async () => {
    await new PlatformAgentPublicationService(db, { invalidation: { publish: vi.fn() } }).rollback(
      'sensitive-admin',
      {
        agentId: identity.id,
        expectedDraftToken: platformAgentDraftToken(identity),
        expectedRevision: 0,
        reason: 'sensitive rollback reason',
        targetVersionId: 'version-id',
      },
    );

    expect(observed).toEqual([
      {
        domain: 'agent_catalog',
        durationMs: expect.any(Number),
        operation: 'rollback',
        outcome: 'success',
        type: 'config_publish',
      },
    ]);
    expect(Object.keys(observed[0]!).sort()).toEqual([
      'domain',
      'durationMs',
      'operation',
      'outcome',
      'type',
    ]);
    expect(JSON.stringify(observed)).not.toContain('sensitive');
    expect(JSON.stringify(observed)).not.toContain('agent-id');
  });

  it('records non-conflict failures without changing the thrown error', async () => {
    const failure = new Error('raw dependency detail');
    mocks.assertDependencies.mockRejectedValue(failure);

    await expect(new PlatformAgentPublicationService(db).publish('admin-id', input)).rejects.toBe(
      failure,
    );
    expect(observed).toEqual([
      {
        domain: 'agent_catalog',
        durationMs: expect.any(Number),
        errorClass: 'UnexpectedError',
        operation: 'publish',
        outcome: 'failure',
        type: 'config_publish',
      },
    ]);
    expect(JSON.stringify(observed)).not.toContain('raw dependency detail');
  });

  it('does not change a committed publication when the observer throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setEnterprisePlatformObserverForTest({
      record: () => {
        throw new Error('observer unavailable');
      },
    });

    await expect(
      new PlatformAgentPublicationService(db).publish('admin-id', input),
    ).resolves.toEqual({ agentId: 'agent-id', revision: 1, versionId: 'version-id' });
    expect(consoleError).toHaveBeenCalledWith(
      '[enterprise-observability] metric sink failed',
      expect.objectContaining({ errorClass: 'UnexpectedError' }),
    );
  });
});
