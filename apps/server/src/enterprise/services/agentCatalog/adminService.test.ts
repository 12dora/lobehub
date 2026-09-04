import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { EnterpriseObservabilityEvent } from '../../observability';
import { setEnterprisePlatformObserverForTest } from '../../observability';
import { PlatformAgentAdminService } from './adminService';
import {
  PlatformAgentDefaultRequiredError,
  PlatformAgentInvalidInputError,
  PlatformAgentResourceInUseError,
  PlatformAgentRevisionConflictError,
} from './errors';
import { translatePlatformAgentPgError } from './pgErrors';
import { platformAgentDraftToken } from './publication';

const mocks = vi.hoisted(() => ({
  acquireDefaultLock: vi.fn(),
  acquireLock: vi.fn(),
  acquireReferenceLock: vi.fn(),
  appendAudit: vi.fn(),
  appendVersionCas: vi.fn(),
  archiveIdentityCas: vi.fn(),
  assertDependencies: vi.fn(),
  countAgentReferences: vi.fn(),
  countAssignmentTargets: vi.fn(),
  countAssignments: vi.fn(),
  countAssignmentsByAgentIds: vi.fn(),
  createAssignment: vi.fn(),
  createIdentity: vi.fn(),
  deleteAssignment: vi.fn(),
  getDefaultIdentity: vi.fn(),
  getDefaultIdentityForUpdate: vi.fn(),
  getExactVersion: vi.fn(),
  getExactVersionsByIds: vi.fn(),
  getIdentity: vi.fn(),
  getIdentityByAgentKey: vi.fn(),
  getAssignment: vi.fn(),
  hardDeleteAgentCascade: vi.fn(),
  listAssignments: vi.fn(),
  listDependentMaterializations: vi.fn(),
  listIdentities: vi.fn(),
  listVersionLabels: vi.fn(),
  lockIdentity: vi.fn(),
  pointToVersionCas: vi.fn(),
  updateAssignment: vi.fn(),
  updateDraftCas: vi.fn(),
}));

vi.mock('@/database/repositories/platformAgentCatalog', () => ({
  acquirePlatformAgentReferenceLock: mocks.acquireReferenceLock,
  PlatformAgentCatalogRepository: class {
    appendVersionCas = mocks.appendVersionCas;
    archiveIdentityCas = mocks.archiveIdentityCas;
    countAgentReferences = mocks.countAgentReferences;
    countAssignmentTargets = mocks.countAssignmentTargets;
    countAssignments = mocks.countAssignments;
    countAssignmentsByAgentIds = mocks.countAssignmentsByAgentIds;
    createAssignment = mocks.createAssignment;
    createIdentity = mocks.createIdentity;
    deleteAssignment = mocks.deleteAssignment;
    getAssignment = mocks.getAssignment;
    getDefaultIdentity = mocks.getDefaultIdentity;
    getDefaultIdentityForUpdate = mocks.getDefaultIdentityForUpdate;
    getExactVersion = mocks.getExactVersion;
    getExactVersionsByIds = mocks.getExactVersionsByIds;
    getIdentity = mocks.getIdentity;
    getIdentityByAgentKey = mocks.getIdentityByAgentKey;
    hardDeleteAgentCascade = mocks.hardDeleteAgentCascade;
    listAssignments = mocks.listAssignments;
    listDependentMaterializations = mocks.listDependentMaterializations;
    listIdentities = mocks.listIdentities;
    listVersionLabels = mocks.listVersionLabels;
    lockIdentity = mocks.lockIdentity;
    pointToVersionCas = mocks.pointToVersionCas;
    updateAssignment = mocks.updateAssignment;
    updateDraftCas = mocks.updateDraftCas;
  },
}));
vi.mock('../platformAudit', () => ({
  PlatformAuditService: class {
    append = mocks.appendAudit;
  },
}));
vi.mock('../platformDependencyLock', () => ({
  acquirePlatformDefaultInboxLock: mocks.acquireDefaultLock,
  acquirePlatformDependencyPublicationLock: mocks.acquireLock,
}));
vi.mock('./dependencyValidator', () => ({
  assertExactPlatformAgentDependencies: mocks.assertDependencies,
}));

const identity = (overrides: Record<string, unknown> = {}) => ({
  agentKey: 'support',
  currentVersionId: 'version-id',
  draftSequence: 4,
  id: 'agent-id',
  isDefault: false,
  migrationRequired: false,
  revision: 2,
  status: 'published',
  systemKey: null,
  ...overrides,
});

/** Minimal publishable payload every de-drafted create carries. */
const createConfig = {
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

const createDependencySnapshot = {
  connectors: [],
  model: {
    modelKey: 'chat',
    providerChecksum: 'a'.repeat(64),
    providerKey: 'provider',
    providerRevision: 1,
  },
  skills: [],
};

const pointer = (value: ReturnType<typeof identity>) => ({
  agentId: value.id,
  expectedDraftToken: platformAgentDraftToken(value),
  expectedRevision: value.revision,
});

/** Duck-typed raw pg driver error understood by `unwrapPgError`. */
const pgError = (code: string, constraint?: string, message = 'db failure') =>
  Object.assign(new Error(message), { code, constraint, severity: 'ERROR' });

const transaction = {} as Transaction;
const db = {
  transaction: vi.fn(async (operation: (tx: Transaction) => Promise<unknown>) =>
    operation(transaction),
  ),
} as unknown as LobeChatDatabase;

const observed: EnterpriseObservabilityEvent[] = [];

describe('PlatformAgentAdminService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observed.length = 0;
    setEnterprisePlatformObserverForTest({ record: (event) => observed.push(event) });
    mocks.appendAudit.mockResolvedValue(undefined);
  });

  afterEach(() => setEnterprisePlatformObserverForTest(null));

  it('keeps assignment writes behind Agent CAS and advances the draft token', async () => {
    const locked = identity();
    mocks.lockIdentity.mockResolvedValue(locked);
    mocks.createAssignment.mockResolvedValue({
      agentId: locked.id,
      enabled: true,
      id: 'assignment-id',
      mode: 'optional',
      pinnedVersionId: null,
      targetId: '__global__',
      targetType: 'global',
      versionPolicy: 'latest_published',
    });
    mocks.updateDraftCas.mockResolvedValue({ ...locked, draftSequence: 5 });

    await expect(
      new PlatformAgentAdminService(db).upsertAssignment('admin-id', {
        ...pointer(locked),
        enabled: true,
        mode: 'optional',
        pinnedVersionId: null,
        reason: 'assign everyone',
        targetId: '__global__',
        targetType: 'global',
        versionPolicy: 'latest_published',
      }),
      // The write bumped the draft sequence, so the refreshed CAS rides back with the row and a
      // chained assignment write needs no re-GET.
    ).resolves.toMatchObject({
      assignment: { id: 'assignment-id' },
      draftToken: expect.stringMatching(/^[\da-f]{64}$/),
      identity: { id: locked.id },
    });
    expect(mocks.createAssignment).toHaveBeenCalledBefore(mocks.updateDraftCas);
    // ADM-02 lock order: reference lock (2) before the identity row lock (3).
    expect(mocks.acquireReferenceLock).toHaveBeenCalledBefore(mocks.lockIdentity);
    expect(mocks.acquireReferenceLock).toHaveBeenCalledWith(expect.anything(), 'agent-id');
    expect(mocks.updateDraftCas).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDraftSequence: 4, expectedRevision: 2 }),
    );

    mocks.lockIdentity.mockResolvedValue({ ...locked, draftSequence: 5 });
    await expect(
      new PlatformAgentAdminService(db).upsertAssignment('admin-id', {
        ...pointer(locked),
        enabled: true,
        mode: 'optional',
        pinnedVersionId: null,
        reason: 'stale assignment',
        targetId: '__global__',
        targetType: 'global',
        versionPolicy: 'latest_published',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
  });

  it('switches default Inbox by clearing the old row before promoting the new row', async () => {
    const previous = identity({
      agentKey: 'old',
      id: 'old-agent',
      isDefault: true,
      systemKey: 'default-inbox',
    });
    const next = identity({ agentKey: 'next', id: 'next-agent' });
    mocks.lockIdentity.mockImplementation(async (id: string) =>
      id === previous.id ? previous : next,
    );
    mocks.updateDraftCas
      .mockResolvedValueOnce({ ...previous, draftSequence: 5, isDefault: false, systemKey: null })
      .mockResolvedValueOnce({
        ...next,
        draftSequence: 5,
        isDefault: true,
        systemKey: 'default-inbox',
      });

    const result = await new PlatformAgentAdminService(db).setDefaultInbox('admin-id', {
      currentDefault: pointer(previous),
      nextDefault: pointer(next),
      reason: 'approved replacement',
    });
    expect(result.currentDefault?.identity.isDefault).toBe(false);
    expect(result.nextDefault.identity.isDefault).toBe(true);
    expect(mocks.updateDraftCas.mock.calls[0]?.[0].patch).toMatchObject({ isDefault: false });
    expect(mocks.updateDraftCas.mock.calls[1]?.[0].patch).toMatchObject({ isDefault: true });
    // ADM-01: the singleton lock is acquired before any row lock.
    expect(mocks.acquireDefaultLock).toHaveBeenCalledBefore(mocks.lockIdentity);
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agents.setDefaultInbox', result: 'success' }),
    );
  });

  it('serializes the first (bootstrap) promotion under the singleton lock', async () => {
    const next = identity({ agentKey: 'first', id: 'first-agent' });
    mocks.lockIdentity.mockResolvedValue(next);
    // A default already exists (committed by the lock winner) → loser rejects, no promotion.
    mocks.getDefaultIdentityForUpdate.mockResolvedValue(identity({ id: 'someone-else' }));

    await expect(
      new PlatformAgentAdminService(db).setDefaultInbox('admin-id', {
        currentDefault: null,
        nextDefault: pointer(next),
        reason: 'first default',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
    expect(mocks.acquireDefaultLock).toHaveBeenCalledBefore(mocks.getDefaultIdentityForUpdate);
    expect(mocks.updateDraftCas).not.toHaveBeenCalled();
  });

  it('requires a published replacement before archiving the current default', async () => {
    const current = identity({ id: 'default-agent', isDefault: true, systemKey: 'default-inbox' });
    mocks.lockIdentity.mockResolvedValue(current);
    mocks.countAgentReferences.mockResolvedValue({ assignments: 1, materializations: 0 });
    await expect(
      new PlatformAgentAdminService(db).archive('admin-id', {
        ...pointer(current),
        reason: 'archive default',
        replacementAgentId: null,
      }),
    ).rejects.toBeInstanceOf(PlatformAgentDefaultRequiredError);
    expect(mocks.countAgentReferences).not.toHaveBeenCalled();
    expect(mocks.archiveIdentityCas).not.toHaveBeenCalled();
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agents.archive', result: 'failure' }),
    );
  });

  it('creates, appends the first version and publishes it in one transaction', async () => {
    const created = identity({
      agentKey: 'plain',
      currentVersionId: null,
      draftSequence: 0,
      id: 'plain-agent',
      revision: 0,
      status: 'draft',
    });
    const publishedVersion = {
      agentId: created.id,
      checksum: 'f'.repeat(64),
      config: createConfig,
      createdAt: new Date('2026-08-15T00:00:00Z'),
      createdBy: 'admin-id',
      dependencySnapshot: createDependencySnapshot,
      id: 'version-id',
      version: '1.0.0',
    };
    mocks.createIdentity.mockResolvedValue(created);
    mocks.appendVersionCas.mockResolvedValue(publishedVersion);
    mocks.pointToVersionCas.mockResolvedValue({
      ...created,
      currentVersionId: publishedVersion.id,
      draftSequence: 2,
      revision: 1,
      status: 'published',
    });

    const result = await new PlatformAgentAdminService(db, {
      invalidation: { publish: vi.fn() },
    }).create('admin-id', {
      agentKey: 'plain',
      config: createConfig,
      dependencySnapshot: createDependencySnapshot,
      isDefault: false,
      reason: 'normal create',
      systemKey: null,
    });

    expect(result).toMatchObject({
      identity: { currentVersionId: 'version-id', revision: 1, status: 'published' },
      invalidationStatus: 'delivered',
      version: { version: '1.0.0' },
    });
    // ADM-01: create enters the shared singleton lock before writing …
    expect(mocks.acquireDefaultLock).toHaveBeenCalledBefore(mocks.createIdentity);
    // … and the version is revalidated under the dependency publication lock.
    expect(mocks.acquireLock).toHaveBeenCalledBefore(mocks.assertDependencies);
    expect(mocks.assertDependencies).toHaveBeenCalledBefore(mocks.appendVersionCas);
    expect(mocks.appendVersionCas).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDraftSequence: 0, expectedRevision: 0, version: '1.0.0' }),
    );
    expect(mocks.pointToVersionCas).toHaveBeenCalledWith(
      expect.objectContaining({ expectedDraftSequence: 1, expectedRevision: 0 }),
    );
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.agents.create',
        afterDiff: expect.objectContaining({ version: '1.0.0', versionId: 'version-id' }),
        result: 'success',
      }),
    );
    // De-drafted write: the publication metric reports the `save` operation, not `publish`.
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

  // ADM-01: create can never touch the managed default-inbox singleton.
  describe('default-inbox state machine (ADM-01)', () => {
    it('rejects create attempting to seed a default Agent', async () => {
      await expect(
        new PlatformAgentAdminService(db).create('admin-id', {
          agentKey: 'seed-default',
          config: createConfig,
          dependencySnapshot: createDependencySnapshot,
          isDefault: true,
          reason: 'sneak a default',
          systemKey: 'default-inbox',
        }),
      ).rejects.toBeInstanceOf(PlatformAgentInvalidInputError);
      expect(mocks.createIdentity).not.toHaveBeenCalled();
    });

    it('rejects create that consumes the reserved default-inbox agentKey', async () => {
      await expect(
        new PlatformAgentAdminService(db).create('admin-id', {
          agentKey: 'default-inbox',
          config: createConfig,
          dependencySnapshot: createDependencySnapshot,
          isDefault: false,
          reason: 'take the reserved key',
          systemKey: null,
        }),
      ).rejects.toBeInstanceOf(PlatformAgentInvalidInputError);
      expect(mocks.createIdentity).not.toHaveBeenCalled();
    });

    it('forces a plain create to a non-default Agent', async () => {
      const created = identity({
        agentKey: 'plain',
        currentVersionId: null,
        draftSequence: 0,
        id: 'plain-agent',
        revision: 0,
        status: 'draft',
      });
      mocks.createIdentity.mockResolvedValue(created);
      mocks.appendVersionCas.mockResolvedValue({
        agentId: created.id,
        checksum: 'f'.repeat(64),
        config: createConfig,
        createdAt: new Date('2026-08-15T00:00:00Z'),
        createdBy: 'admin-id',
        dependencySnapshot: createDependencySnapshot,
        id: 'version-id',
        version: '1.0.0',
      });
      mocks.pointToVersionCas.mockResolvedValue({
        ...created,
        currentVersionId: 'version-id',
        draftSequence: 2,
        revision: 1,
        status: 'published',
      });
      await new PlatformAgentAdminService(db, { invalidation: { publish: vi.fn() } }).create(
        'admin-id',
        {
          agentKey: 'plain',
          config: createConfig,
          dependencySnapshot: createDependencySnapshot,
          isDefault: false,
          reason: 'normal create',
          systemKey: null,
        },
      );
      expect(mocks.createIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: false, systemKey: null }),
      );
      // ADM-01: create enters the shared singleton lock before writing.
      expect(mocks.acquireDefaultLock).toHaveBeenCalledBefore(mocks.createIdentity);
    });
  });

  // ADM-02: archive with any live reference is a stable resource-in-use rejection.
  describe('archive reference protection (ADM-02)', () => {
    it('rejects archive when assignments reference the Agent', async () => {
      const current = identity({ id: 'ref-agent', isDefault: false, systemKey: null });
      mocks.lockIdentity.mockResolvedValue(current);
      mocks.countAgentReferences.mockResolvedValue({ assignments: 3, materializations: 0 });
      await expect(
        new PlatformAgentAdminService(db).archive('admin-id', {
          ...pointer(current),
          reason: 'archive referenced',
          replacementAgentId: null,
        }),
      ).rejects.toBeInstanceOf(PlatformAgentResourceInUseError);
      expect(mocks.archiveIdentityCas).not.toHaveBeenCalled();
      expect(mocks.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'admin.agents.archive',
          afterDiff: { error: 'resource_in_use' },
          result: 'failure',
        }),
      );
    });

    it('rejects archive when only materializations reference the Agent', async () => {
      const current = identity({ id: 'ref-agent', isDefault: false, systemKey: null });
      mocks.lockIdentity.mockResolvedValue(current);
      mocks.countAgentReferences.mockResolvedValue({ assignments: 0, materializations: 1 });
      await expect(
        new PlatformAgentAdminService(db).archive('admin-id', {
          ...pointer(current),
          reason: 'archive materialized',
          replacementAgentId: null,
        }),
      ).rejects.toBeInstanceOf(PlatformAgentResourceInUseError);
      expect(mocks.acquireDefaultLock).toHaveBeenCalledBefore(mocks.lockIdentity);
    });

    it('archives an unreferenced non-default Agent', async () => {
      const current = identity({ id: 'free-agent', isDefault: false, systemKey: null });
      mocks.lockIdentity.mockResolvedValue(current);
      mocks.countAgentReferences.mockResolvedValue({ assignments: 0, materializations: 0 });
      mocks.archiveIdentityCas.mockResolvedValue({
        ...current,
        revision: current.revision + 1,
        status: 'archived',
      });
      await expect(
        new PlatformAgentAdminService(db).archive('admin-id', {
          ...pointer(current),
          reason: 'clean archive',
          replacementAgentId: null,
        }),
      ).resolves.toMatchObject({ identity: { status: 'archived' } });
    });
  });

  // ADM-03: raw pg constraint / trigger failures normalize to stable, redacted errors.
  describe('constraint error normalization (ADM-03)', () => {
    it('maps translatePlatformAgentPgError by actual constraint / trigger, not blanket SQLSTATE', () => {
      // 23505 system-key race → RevisionConflict; other known unique indexes → InvalidInput.
      expect(
        translatePlatformAgentPgError(pgError('23505', 'platform_agents_system_key_unique')),
      ).toBeInstanceOf(PlatformAgentRevisionConflictError);
      expect(
        translatePlatformAgentPgError(pgError('23505', 'platform_agents_agent_key_unique')),
      ).toBeInstanceOf(PlatformAgentInvalidInputError);
      expect(
        translatePlatformAgentPgError(
          pgError('23505', 'platform_agent_versions_agent_id_version_unique'),
        ),
      ).toBeInstanceOf(PlatformAgentInvalidInputError);
      expect(
        translatePlatformAgentPgError(
          pgError('23505', 'platform_agent_assignments_agent_target_unique'),
        ),
      ).toBeInstanceOf(PlatformAgentInvalidInputError);
      // 23503 mapped only for a known platform-Agent FK constraint …
      expect(
        translatePlatformAgentPgError(
          pgError('23503', 'platform_agent_assignments_pinned_version_same_agent_fk'),
        ),
      ).toBeInstanceOf(PlatformAgentInvalidInputError);
      // … including the two materialization FKs whose names PostgreSQL truncates to 63 bytes.
      expect(
        translatePlatformAgentPgError(
          pgError('23503', 'platform_user_agent_materializations_platform_agent_id_platform'),
        ),
      ).toBeInstanceOf(PlatformAgentInvalidInputError);
      expect(
        translatePlatformAgentPgError(
          pgError('23503', 'platform_user_agent_materializations_materialized_agent_id_agen'),
        ),
      ).toBeInstanceOf(PlatformAgentInvalidInputError);
      // … or a recognized target-guard trigger message (triggers carry no constraint name).
      expect(
        translatePlatformAgentPgError(
          pgError('23503', undefined, 'platform Agent assignments require an existing user'),
        ),
      ).toBeInstanceOf(PlatformAgentInvalidInputError);
      // A bare / unknown 23503 or 23505 is NOT misclassified — it surfaces unchanged.
      const bareFk = pgError('23503', undefined, 'some unrelated fk');
      expect(translatePlatformAgentPgError(bareFk)).toBe(bareFk);
      const unknownUnique = pgError('23505', 'some_other_unique');
      expect(translatePlatformAgentPgError(unknownUnique)).toBe(unknownUnique);
      // Non-pg errors pass through untouched so genuine bugs still surface.
      const bug = new Error('boom');
      expect(translatePlatformAgentPgError(bug)).toBe(bug);
    });

    it('maps a duplicate agent key to a redacted InvalidInput and stable failure audit', async () => {
      mocks.createIdentity.mockRejectedValue(pgError('23505', 'platform_agents_agent_key_unique'));
      const error = await new PlatformAgentAdminService(db)
        .create('admin-id', {
          agentKey: 'dup',
          config: createConfig,
          dependencySnapshot: createDependencySnapshot,
          isDefault: false,
          reason: 'duplicate key',
          systemKey: null,
        })
        .catch((raw) => raw);
      expect(error).toBeInstanceOf(PlatformAgentInvalidInputError);
      // Redaction: the surfaced error carries no constraint / value.
      expect(JSON.stringify({ code: error.code, message: error.message })).not.toMatch(
        /agent_key|constraint|dup|23505/,
      );
      expect(mocks.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'admin.agents.create',
          afterDiff: { error: 'invalid_input' },
          result: 'failure',
        }),
      );
      // De-drafted write: the failed create reports the `save` operation, redacted.
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
      expect(JSON.stringify(observed)).not.toContain('dup');
    });

    it('maps a default-inbox unique race to a RevisionConflict', async () => {
      const next = identity({ agentKey: 'winner', id: 'winner-agent' });
      mocks.lockIdentity.mockResolvedValue(next);
      mocks.getDefaultIdentityForUpdate.mockResolvedValue(undefined);
      mocks.updateDraftCas.mockRejectedValue(pgError('23505', 'platform_agents_system_key_unique'));
      await expect(
        new PlatformAgentAdminService(db).setDefaultInbox('admin-id', {
          currentDefault: null,
          nextDefault: pointer(next),
          reason: 'racing promotion',
        }),
      ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
    });
  });

  // ADM-04: list / getDependents use batched queries, not per-item lookups.
  describe('batched reads (ADM-04)', () => {
    it('resolves list versions and assignment counts with batched queries only', async () => {
      const items = Array.from({ length: 40 }, (_, index) =>
        identity({
          agentKey: `agent-${index}`,
          currentVersionId: `ver-${index}`,
          id: `id-${index}`,
        }),
      );
      mocks.listIdentities.mockResolvedValue({ items, nextCursor: null });
      mocks.getExactVersionsByIds.mockResolvedValue(
        new Map(
          items.map((item) => [
            item.currentVersionId,
            { config: { displayName: `Name ${item.id}` }, version: '1.2.3' },
          ]),
        ),
      );
      mocks.countAssignmentsByAgentIds.mockResolvedValue(
        new Map(items.map((item, index) => [item.id, index])),
      );

      const result = await new PlatformAgentAdminService(db).list({ limit: 50 });

      expect(result.items).toHaveLength(40);
      expect(result.items[3]).toMatchObject({
        assignmentCount: 3,
        displayName: 'Name id-3',
        publishedVersion: '1.2.3',
      });
      // Exactly one batched call each; never the per-item helpers.
      expect(mocks.getExactVersionsByIds).toHaveBeenCalledTimes(1);
      expect(mocks.countAssignmentsByAgentIds).toHaveBeenCalledTimes(1);
      expect(mocks.getExactVersion).not.toHaveBeenCalled();
      expect(mocks.countAssignments).not.toHaveBeenCalled();
    });

    it('resolves dependents versions with a single batched query', async () => {
      const assignments = Array.from({ length: 30 }, (_, index) => ({
        agentId: 'agent-id',
        enabled: true,
        id: `assignment-${index}`,
        mode: 'optional',
        pinnedVersionId: `pin-${index}`,
        targetId: `user-${index}`,
        targetType: 'user',
        versionPolicy: 'pinned',
      }));
      mocks.listAssignments.mockResolvedValue({ items: assignments, nextCursor: 'cursor-next' });
      mocks.getExactVersionsByIds.mockResolvedValue(
        new Map(
          assignments.map((assignment) => [assignment.pinnedVersionId, { version: '2.0.0' }]),
        ),
      );

      const result = await new PlatformAgentAdminService(db).getDependents({
        agentId: 'agent-id',
        limit: 50,
      });

      expect(result.items).toHaveLength(30);
      expect(result.items[0]).toMatchObject({ type: 'assignment', version: '2.0.0' });
      expect(result.nextCursor).toBe('a:cursor-next');
      expect(mocks.getExactVersionsByIds).toHaveBeenCalledTimes(1);
      expect(mocks.getExactVersion).not.toHaveBeenCalled();
      // Assignment page still has a next cursor, so materializations are not fetched.
      expect(mocks.listDependentMaterializations).not.toHaveBeenCalled();
    });
  });

  describe('delete CAS', () => {
    it('rejects delete after draftSequence changes (full identity CAS)', async () => {
      const locked = identity({ draftSequence: 5, revision: 2 });
      mocks.lockIdentity.mockResolvedValue(locked);

      await expect(
        new PlatformAgentAdminService(db).delete('admin-id', {
          agentId: locked.id,
          // Stale token from draftSequence 4 — revision alone would still match.
          expectedDraftToken: platformAgentDraftToken(identity({ draftSequence: 4, revision: 2 })),
          expectedRevision: 2,
          reason: 'stale delete after assignment',
        }),
      ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
      expect(mocks.hardDeleteAgentCascade).not.toHaveBeenCalled();
    });

    it('hard-deletes when full identity CAS matches', async () => {
      const locked = identity();
      mocks.lockIdentity.mockResolvedValue(locked);
      mocks.hardDeleteAgentCascade.mockResolvedValue(undefined);

      await expect(
        new PlatformAgentAdminService(db).delete('admin-id', {
          agentId: locked.id,
          expectedDraftToken: platformAgentDraftToken(locked),
          expectedRevision: locked.revision,
          reason: 'retire assistant',
        }),
      ).resolves.toEqual({ deleted: true });
      expect(mocks.hardDeleteAgentCascade).toHaveBeenCalledWith(locked.id);
      expect(mocks.acquireDefaultLock).toHaveBeenCalled();
      expect(mocks.acquireReferenceLock).toHaveBeenCalledWith(expect.anything(), locked.id);
    });

    it('refuses to delete the default inbox identity', async () => {
      const locked = identity({ isDefault: true, systemKey: 'default-inbox' });
      mocks.lockIdentity.mockResolvedValue(locked);

      await expect(
        new PlatformAgentAdminService(db).delete('admin-id', {
          agentId: locked.id,
          expectedDraftToken: platformAgentDraftToken(locked),
          expectedRevision: locked.revision,
          reason: 'delete default inbox',
        }),
      ).rejects.toBeInstanceOf(PlatformAgentDefaultRequiredError);
      expect(mocks.hardDeleteAgentCascade).not.toHaveBeenCalled();
    });
  });

  it('returns ASSIGNMENT_DISABLED warning code for disabled assignment preview', async () => {
    mocks.getIdentity.mockResolvedValue(identity());
    mocks.countAssignmentTargets.mockResolvedValue(12);

    await expect(
      new PlatformAgentAdminService(db).previewAssignment({
        agentId: 'agent-id',
        assignment: {
          enabled: false,
          mode: 'optional',
          pinnedVersionId: null,
          targetId: '__global__',
          targetType: 'global',
          versionPolicy: 'latest_published',
        },
      }),
    ).resolves.toEqual({
      estimatedUsers: 12,
      warnings: ['ASSIGNMENT_DISABLED'],
    });
  });

  it('returns MANDATORY_AGENT_CANNOT_BE_HIDDEN for mandatory assignment preview', async () => {
    mocks.getIdentity.mockResolvedValue(identity());
    mocks.countAssignmentTargets.mockResolvedValue(8);

    await expect(
      new PlatformAgentAdminService(db).previewAssignment({
        agentId: 'agent-id',
        assignment: {
          enabled: true,
          mode: 'mandatory',
          pinnedVersionId: null,
          targetId: '__global__',
          targetType: 'global',
          versionPolicy: 'latest_published',
        },
      }),
    ).resolves.toEqual({
      estimatedUsers: 8,
      warnings: ['MANDATORY_AGENT_CANNOT_BE_HIDDEN'],
    });
  });

  it('returns both warnings for a disabled mandatory assignment preview', async () => {
    mocks.getIdentity.mockResolvedValue(identity());
    mocks.countAssignmentTargets.mockResolvedValue(3);

    await expect(
      new PlatformAgentAdminService(db).previewAssignment({
        agentId: 'agent-id',
        assignment: {
          enabled: false,
          mode: 'mandatory',
          pinnedVersionId: null,
          targetId: '__global__',
          targetType: 'global',
          versionPolicy: 'latest_published',
        },
      }),
    ).resolves.toEqual({
      estimatedUsers: 3,
      warnings: ['ASSIGNMENT_DISABLED', 'MANDATORY_AGENT_CANNOT_BE_HIDDEN'],
    });
  });

  describe('provisionDefaultInbox', () => {
    const seed = {
      config: createConfig,
      dependencySnapshot: createDependencySnapshot,
    };

    it('creates a published default-inbox identity, global assignment, and audit row', async () => {
      const created = identity({
        agentKey: 'default-inbox',
        currentVersionId: null,
        draftSequence: 0,
        id: 'inbox-agent',
        isDefault: true,
        revision: 0,
        status: 'draft',
        systemKey: 'default-inbox',
      });
      const published = {
        ...created,
        currentVersionId: 'version-id',
        draftSequence: 2,
        revision: 1,
        status: 'published',
      };
      mocks.getDefaultIdentity.mockResolvedValue(undefined);
      mocks.getIdentityByAgentKey.mockResolvedValue(undefined);
      mocks.createIdentity.mockResolvedValue(created);
      mocks.appendVersionCas.mockResolvedValue({
        agentId: created.id,
        checksum: 'f'.repeat(64),
        config: createConfig,
        createdAt: new Date('2026-09-04T00:00:00Z'),
        createdBy: 'admin-id',
        dependencySnapshot: createDependencySnapshot,
        id: 'version-id',
        version: '1.0.0',
      });
      mocks.pointToVersionCas.mockResolvedValue(published);
      mocks.lockIdentity.mockResolvedValue(published);
      mocks.listAssignments.mockResolvedValue({ items: [], nextCursor: null });
      mocks.createAssignment.mockResolvedValue({
        agentId: published.id,
        enabled: true,
        id: 'global-assignment',
        mode: 'default',
        pinnedVersionId: null,
        status: 'active',
        targetId: '__global__',
        targetType: 'global',
        versionPolicy: 'latest_published',
      });
      mocks.updateDraftCas.mockResolvedValue({ ...published, draftSequence: 3 });

      const buildSeed = vi.fn(async () => seed);
      const result = await new PlatformAgentAdminService(db, {
        buildDefaultInboxSeed: buildSeed,
        invalidation: { publish: vi.fn() },
      }).provisionDefaultInbox({ actorId: 'admin-id', locale: 'zh-CN' });

      expect(result.identity).toMatchObject({
        agentKey: 'default-inbox',
        isDefault: true,
        status: 'published',
        systemKey: 'default-inbox',
      });
      expect(mocks.acquireDefaultLock).toHaveBeenCalledBefore(mocks.createIdentity);
      expect(mocks.acquireReferenceLock).toHaveBeenCalledBefore(mocks.lockIdentity);
      expect(mocks.createIdentity).toHaveBeenCalledWith(
        expect.objectContaining({
          agentKey: 'default-inbox',
          isDefault: true,
          systemKey: 'default-inbox',
        }),
      );
      expect(mocks.createAssignment).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          mode: 'default',
          targetId: '__global__',
          targetType: 'global',
        }),
      );
      expect(buildSeed).toHaveBeenCalledWith(expect.anything(), { locale: 'zh-CN' });
      expect(mocks.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'admin.agents.provisionDefaultInbox',
          afterDiff: expect.objectContaining({ created: true, locale: 'zh-CN' }),
          result: 'success',
        }),
      );
    });

    it('is idempotent when the default inbox already has an effective global assignment', async () => {
      const existing = identity({
        agentKey: 'default-inbox',
        id: 'inbox-agent',
        isDefault: true,
        systemKey: 'default-inbox',
      });
      mocks.getDefaultIdentity.mockResolvedValue(existing);
      mocks.lockIdentity.mockResolvedValue(existing);
      mocks.listAssignments.mockResolvedValue({
        items: [
          {
            agentId: existing.id,
            enabled: true,
            id: 'global-assignment',
            mode: 'default',
            pinnedVersionId: null,
            status: 'active',
            targetId: '__global__',
            targetType: 'global',
            versionPolicy: 'latest_published',
          },
        ],
        nextCursor: null,
      });

      const result = await new PlatformAgentAdminService(db, {
        buildDefaultInboxSeed: async () => seed,
      }).provisionDefaultInbox({ actorId: 'admin-id' });

      expect(result.identity.id).toBe(existing.id);
      expect(mocks.createIdentity).not.toHaveBeenCalled();
      expect(mocks.createAssignment).not.toHaveBeenCalled();
      expect(mocks.updateAssignment).not.toHaveBeenCalled();
      expect(mocks.acquireDefaultLock).toHaveBeenCalledBefore(mocks.acquireReferenceLock);
      expect(mocks.acquireReferenceLock).toHaveBeenCalledBefore(mocks.lockIdentity);
      expect(mocks.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'admin.agents.provisionDefaultInbox',
          afterDiff: expect.objectContaining({ created: false }),
          result: 'success',
        }),
      );
    });

    it('re-enables a disabled global assignment on the existing default inbox', async () => {
      const existing = identity({
        agentKey: 'default-inbox',
        id: 'inbox-agent',
        isDefault: true,
        systemKey: 'default-inbox',
      });
      mocks.getDefaultIdentity.mockResolvedValue(existing);
      mocks.lockIdentity.mockResolvedValue(existing);
      mocks.listAssignments.mockResolvedValue({
        items: [
          {
            agentId: existing.id,
            enabled: false,
            id: 'global-assignment',
            mode: 'default',
            pinnedVersionId: null,
            status: 'active',
            targetId: '__global__',
            targetType: 'global',
            versionPolicy: 'latest_published',
          },
        ],
        nextCursor: null,
      });
      mocks.updateAssignment.mockResolvedValue({
        agentId: existing.id,
        enabled: true,
        id: 'global-assignment',
        mode: 'default',
        pinnedVersionId: null,
        status: 'active',
        targetId: '__global__',
        targetType: 'global',
        versionPolicy: 'latest_published',
      });
      mocks.updateDraftCas.mockResolvedValue({ ...existing, draftSequence: 5 });

      await new PlatformAgentAdminService(db).provisionDefaultInbox({ actorId: 'admin-id' });
      expect(mocks.updateAssignment).toHaveBeenCalledWith(
        existing.id,
        'global-assignment',
        expect.objectContaining({ enabled: true, status: 'active' }),
      );
      expect(mocks.createIdentity).not.toHaveBeenCalled();
    });

    it('activates a pending global assignment so runtime resolution can pick it up', async () => {
      const existing = identity({
        agentKey: 'default-inbox',
        id: 'inbox-agent',
        isDefault: true,
        systemKey: 'default-inbox',
      });
      mocks.getDefaultIdentity.mockResolvedValue(existing);
      mocks.lockIdentity.mockResolvedValue(existing);
      mocks.listAssignments.mockResolvedValue({
        items: [
          {
            agentId: existing.id,
            enabled: true,
            id: 'global-assignment',
            mode: 'default',
            pinnedVersionId: null,
            status: 'pending',
            targetId: '__global__',
            targetType: 'global',
            versionPolicy: 'latest_published',
          },
        ],
        nextCursor: null,
      });
      mocks.updateAssignment.mockResolvedValue({
        agentId: existing.id,
        enabled: true,
        id: 'global-assignment',
        mode: 'default',
        pinnedVersionId: null,
        status: 'active',
        targetId: '__global__',
        targetType: 'global',
        versionPolicy: 'latest_published',
      });
      mocks.updateDraftCas.mockResolvedValue({ ...existing, draftSequence: 5 });

      await new PlatformAgentAdminService(db).provisionDefaultInbox({ actorId: 'admin-id' });
      expect(mocks.updateAssignment).toHaveBeenCalledWith(
        existing.id,
        'global-assignment',
        expect.objectContaining({ enabled: true, status: 'active' }),
      );
      expect(mocks.createIdentity).not.toHaveBeenCalled();
    });

    it('refuses to silently adopt a non-default identity that already holds the reserved key', async () => {
      const occupant = identity({
        agentKey: 'default-inbox',
        id: 'occupant-agent',
        isDefault: false,
        systemKey: null,
      });
      mocks.getDefaultIdentity.mockResolvedValue(undefined);
      mocks.getIdentityByAgentKey.mockResolvedValue(occupant);

      await expect(
        new PlatformAgentAdminService(db).provisionDefaultInbox({ actorId: 'admin-id' }),
      ).rejects.toBeInstanceOf(PlatformAgentDefaultRequiredError);
      await expect(
        new PlatformAgentAdminService(db).provisionDefaultInbox({ actorId: 'admin-id' }),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/default-inbox.*non-default identity/),
      });
      expect(mocks.createIdentity).not.toHaveBeenCalled();
      expect(mocks.createAssignment).not.toHaveBeenCalled();
    });
  });

  it('refuses to disable the default inbox global assignment', async () => {
    const locked = identity({ isDefault: true, systemKey: 'default-inbox' });
    mocks.lockIdentity.mockResolvedValue(locked);
    mocks.getAssignment.mockResolvedValue({
      agentId: locked.id,
      enabled: true,
      id: 'global-assignment',
      mode: 'default',
      pinnedVersionId: null,
      targetId: '__global__',
      targetType: 'global',
      versionPolicy: 'latest_published',
    });

    await expect(
      new PlatformAgentAdminService(db).upsertAssignment('admin-id', {
        ...pointer(locked),
        assignmentId: 'global-assignment',
        enabled: false,
        mode: 'default',
        pinnedVersionId: null,
        reason: 'disable default inbox',
        targetId: '__global__',
        targetType: 'global',
        versionPolicy: 'latest_published',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentDefaultRequiredError);
    expect(mocks.updateAssignment).not.toHaveBeenCalled();
  });

  it('refuses to remove the default inbox global assignment', async () => {
    const locked = identity({ isDefault: true, systemKey: 'default-inbox' });
    mocks.lockIdentity.mockResolvedValue(locked);
    mocks.getAssignment.mockResolvedValue({
      agentId: locked.id,
      enabled: true,
      id: 'global-assignment',
      mode: 'default',
      pinnedVersionId: null,
      targetId: '__global__',
      targetType: 'global',
      versionPolicy: 'latest_published',
    });

    await expect(
      new PlatformAgentAdminService(db).removeAssignment('admin-id', {
        ...pointer(locked),
        assignmentId: 'global-assignment',
        reason: 'remove default inbox',
      }),
    ).rejects.toBeInstanceOf(PlatformAgentDefaultRequiredError);
    expect(mocks.deleteAssignment).not.toHaveBeenCalled();
  });
});
