import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { EnterpriseObservabilityEvent } from '../../observability';
import { setEnterprisePlatformObserverForTest } from '../../observability';
import { PlatformAgentInvalidInputError, PlatformAgentRevisionConflictError } from './errors';
import {
  nextPlatformAgentVersion,
  platformAgentDraftToken,
  PlatformAgentPublicationService,
} from './publication';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  appendAudit: vi.fn(),
  appendVersionCas: vi.fn(),
  assertDependencies: vi.fn(),
  getExactVersion: vi.fn(),
  listVersionLabels: vi.fn(),
  lockIdentity: vi.fn(),
  pointToVersionCas: vi.fn(),
}));

vi.mock('@/database/repositories/platformAgentCatalog', () => ({
  PlatformAgentCatalogRepository: class {
    appendVersionCas = mocks.appendVersionCas;
    getExactVersion = mocks.getExactVersion;
    listVersionLabels = mocks.listVersionLabels;
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
const input = {
  agentId: identity.id,
  config,
  dependencySnapshot,
  expectedDraftToken: platformAgentDraftToken(identity),
  expectedRevision: 0,
  reason: 'save reviewed change',
};
const version = {
  agentId: identity.id,
  checksum: 'f'.repeat(64),
  config,
  createdAt: new Date('2026-08-15T00:00:00Z'),
  createdBy: 'admin-id',
  dependencySnapshot,
  id: 'version-id',
  version: '1.0.1',
};
const published = { ...identity, currentVersionId: version.id, revision: 1, status: 'published' };

const transaction = {} as Transaction;
const db = {
  transaction: vi.fn(async (operation: (tx: Transaction) => Promise<unknown>) =>
    operation(transaction),
  ),
} as unknown as LobeChatDatabase;
const observed: EnterpriseObservabilityEvent[] = [];

describe('nextPlatformAgentVersion (server-owned label)', () => {
  it('starts at 1.0.0 only when the Agent has no versions at all', () => {
    expect(nextPlatformAgentVersion([])).toBe('1.0.0');
  });

  it('bumps the HIGHEST valid SemVer, not the newest created label', () => {
    expect(nextPlatformAgentVersion(['1.0.0'])).toBe('1.0.1');
    expect(nextPlatformAgentVersion(['2.4.9'])).toBe('2.4.10');
    // Ordered oldest-first: the newest row is malformed / lower, the highest valid one wins.
    expect(nextPlatformAgentVersion(['1.0.0', '2.4.9', '1.0.1'])).toBe('2.4.10');
    expect(nextPlatformAgentVersion(['3.0.0', 'v4', '1.9.9'])).toBe('3.0.1');
    expect(nextPlatformAgentVersion(['1.9.9', '1.10.0'])).toBe('1.10.1'); // numeric, not lexical
  });

  it('drops prerelease / build metadata instead of producing NaN', () => {
    expect(nextPlatformAgentVersion(['1.2.3+build.5'])).toBe('1.2.4');
    expect(nextPlatformAgentVersion(['1.2.3-alpha.1'])).toBe('1.2.4');
  });

  it('parks malformed-only histories in the 0.0.x family so 1.0.0 can never collide', () => {
    // 1.0.0 may already exist under a malformed sibling label — never reuse it here.
    expect(nextPlatformAgentVersion(['not-a-version'])).toBe('0.0.2');
    expect(nextPlatformAgentVersion(['1.0', 'draft', '01.2.3'])).toBe('0.0.4');
    // Once a 0.0.x label exists it is itself valid SemVer, so the bump branch takes over.
    expect(nextPlatformAgentVersion(['not-a-version', '0.0.2'])).toBe('0.0.3');
  });
});

describe('PlatformAgentPublicationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observed.length = 0;
    setEnterprisePlatformObserverForTest({ record: (event) => observed.push(event) });
    mocks.assertDependencies.mockResolvedValue(undefined);
    mocks.lockIdentity.mockResolvedValue(identity);
    mocks.listVersionLabels.mockResolvedValue(['1.0.0']);
    mocks.appendVersionCas.mockResolvedValue(version);
    mocks.getExactVersion.mockResolvedValue({
      checksum: 'f'.repeat(64),
      dependencySnapshot,
      id: 'version-id',
      version: '1.0.0',
    });
    mocks.pointToVersionCas.mockResolvedValue(published);
  });

  afterEach(() => setEnterprisePlatformObserverForTest(null));

  it('locks, revalidates, appends and publishes one version, then audits before invalidation', async () => {
    const publish = vi.fn();
    const result = await new PlatformAgentPublicationService(db, {
      invalidation: { publish },
    }).save('admin-id', input);

    expect(result).toMatchObject({
      identity: { currentVersionId: 'version-id', revision: 1, status: 'published' },
      invalidationStatus: 'delivered',
      version: { id: 'version-id', version: '1.0.1' },
    });
    expect(result.draftToken).toBe(platformAgentDraftToken(published));
    expect(mocks.lockIdentity).toHaveBeenCalledBefore(mocks.acquireLock);
    expect(mocks.acquireLock).toHaveBeenCalledBefore(mocks.assertDependencies);
    expect(mocks.assertDependencies).toHaveBeenCalledBefore(mocks.appendVersionCas);
    // Server-generated label: patch bump of the latest existing version.
    expect(mocks.appendVersionCas).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDraftSequence: 4, expectedRevision: 0, version: '1.0.1' }),
    );
    // The pointer move continues from the sequence appendVersionCas advanced to.
    expect(mocks.pointToVersionCas).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDraftSequence: 5,
        expectedRevision: 0,
        versionId: 'version-id',
      }),
    );
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agents.save', result: 'success' }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'agent-id', revision: 1 }),
    );
    expect(observed).toEqual([
      {
        domain: 'agent_catalog',
        durationMs: expect.any(Number),
        operation: 'save',
        outcome: 'success',
        type: 'config_publish',
      },
    ]);
  });

  it('labels the first version 1.0.0 when the Agent has none yet', async () => {
    mocks.listVersionLabels.mockResolvedValue([]);
    mocks.appendVersionCas.mockResolvedValue({ ...version, version: '1.0.0' });
    await new PlatformAgentPublicationService(db, { invalidation: { publish: vi.fn() } }).save(
      'admin-id',
      input,
    );
    expect(mocks.appendVersionCas).toHaveBeenCalledWith(
      expect.objectContaining({ version: '1.0.0' }),
    );
  });

  it('rolls back the transaction path on stale CAS and does not invalidate', async () => {
    const publish = vi.fn();
    mocks.lockIdentity.mockResolvedValue({ ...identity, draftSequence: 5 });
    await expect(
      new PlatformAgentPublicationService(db, { invalidation: { publish } }).save(
        'admin-id',
        input,
      ),
    ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
    expect(mocks.appendVersionCas).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agents.save', result: 'failure' }),
    );
    expect(observed).toEqual([
      {
        domain: 'agent_catalog',
        durationMs: expect.any(Number),
        errorClass: 'ConflictError',
        operation: 'save',
        outcome: 'conflict',
        type: 'config_publish',
      },
    ]);
  });

  it('rejects a lost pointer CAS after the version row was appended', async () => {
    mocks.pointToVersionCas.mockResolvedValue(undefined);
    await expect(
      new PlatformAgentPublicationService(db, { invalidation: { publish: vi.fn() } }).save(
        'admin-id',
        input,
      ),
    ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agents.save', result: 'failure' }),
    );
  });

  it('does not convert a committed save into failure when invalidation throws', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('redis unavailable'));
    await expect(
      new PlatformAgentPublicationService(db, { invalidation: { publish } }).save(
        'admin-id',
        input,
      ),
    ).resolves.toMatchObject({ invalidationStatus: 'deferred' });
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

    await expect(new PlatformAgentPublicationService(db).save('admin-id', input)).rejects.toBe(
      failure,
    );
    expect(observed).toEqual([
      {
        domain: 'agent_catalog',
        durationMs: expect.any(Number),
        errorClass: 'UnexpectedError',
        operation: 'save',
        outcome: 'failure',
        type: 'config_publish',
      },
    ]);
    expect(JSON.stringify(observed)).not.toContain('raw dependency detail');
  });

  it('normalizes a raw duplicate-version constraint failure into a redacted invalid input', async () => {
    mocks.appendVersionCas.mockRejectedValue(
      Object.assign(new Error('db failure'), {
        code: '23505',
        constraint: 'platform_agent_versions_agent_id_version_unique',
        severity: 'ERROR',
      }),
    );
    const error = await new PlatformAgentPublicationService(db)
      .save('admin-id', input)
      .catch((raw) => raw);
    expect(error).toBeInstanceOf(PlatformAgentInvalidInputError);
    expect(JSON.stringify({ message: error.message })).not.toMatch(/23505|constraint|unique/);
  });

  it('does not change a committed publication when the observer throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setEnterprisePlatformObserverForTest({
      record: () => {
        throw new Error('observer unavailable');
      },
    });

    await expect(
      new PlatformAgentPublicationService(db).save('admin-id', input),
    ).resolves.toMatchObject({ invalidationStatus: 'delivered' });
    expect(consoleError).toHaveBeenCalledWith(
      '[enterprise-observability] metric sink failed',
      expect.objectContaining({ errorClass: 'UnexpectedError' }),
    );
  });
});
