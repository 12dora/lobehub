import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase, Transaction } from '@/database/type';

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
  getDefaultIdentityForUpdate: vi.fn(),
  getExactVersion: vi.fn(),
  getExactVersionsByIds: vi.fn(),
  getIdentity: vi.fn(),
  hardDeleteAgentCascade: vi.fn(),
  listAssignments: vi.fn(),
  listDependentMaterializations: vi.fn(),
  listIdentities: vi.fn(),
  lockIdentity: vi.fn(),
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
    getDefaultIdentityForUpdate = mocks.getDefaultIdentityForUpdate;
    getExactVersion = mocks.getExactVersion;
    getExactVersionsByIds = mocks.getExactVersionsByIds;
    getIdentity = mocks.getIdentity;
    hardDeleteAgentCascade = mocks.hardDeleteAgentCascade;
    listAssignments = mocks.listAssignments;
    listDependentMaterializations = mocks.listDependentMaterializations;
    listIdentities = mocks.listIdentities;
    lockIdentity = mocks.lockIdentity;
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

describe('PlatformAgentAdminService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appendAudit.mockResolvedValue(undefined);
  });

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
    ).resolves.toMatchObject({ id: 'assignment-id' });
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
    mocks.countAgentReferences.mockResolvedValue({ assignments: 0, materializations: 0 });
    await expect(
      new PlatformAgentAdminService(db).archive('admin-id', {
        ...pointer(current),
        reason: 'archive default',
        replacementAgentId: null,
      }),
    ).rejects.toBeInstanceOf(PlatformAgentDefaultRequiredError);
    expect(mocks.archiveIdentityCas).not.toHaveBeenCalled();
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agents.archive', result: 'failure' }),
    );
  });

  it('appends a secret-free version under CAS and dependency-lock revalidation', async () => {
    const locked = identity({ currentVersionId: null, status: 'draft' });
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
    mocks.lockIdentity.mockResolvedValue(locked);
    mocks.appendVersionCas.mockResolvedValue({
      agentId: locked.id,
      checksum: 'f'.repeat(64),
      config,
      createdAt: new Date('2026-07-17T00:00:00Z'),
      createdBy: 'admin-id',
      dependencySnapshot,
      id: 'version-id',
      version: '1.0.0',
    });
    mocks.getIdentity.mockResolvedValue({ ...locked, draftSequence: 5 });

    await new PlatformAgentAdminService(db).appendVersion('admin-id', {
      ...pointer(locked),
      config,
      dependencySnapshot,
      reason: 'create reviewed version',
      version: '1.0.0',
    });
    expect(mocks.acquireLock).toHaveBeenCalledBefore(mocks.assertDependencies);
    expect(mocks.assertDependencies).toHaveBeenCalledBefore(mocks.appendVersionCas);
  });

  // ADM-01: create / updateDraft can never touch the managed default-inbox singleton.
  describe('default-inbox state machine (ADM-01)', () => {
    it('rejects create attempting to seed a default Agent', async () => {
      await expect(
        new PlatformAgentAdminService(db).create('admin-id', {
          agentKey: 'seed-default',
          isDefault: true,
          reason: 'sneak a default',
          systemKey: 'default-inbox',
        }),
      ).rejects.toBeInstanceOf(PlatformAgentInvalidInputError);
      expect(mocks.createIdentity).not.toHaveBeenCalled();
    });

    it('forces a plain create to a non-default draft', async () => {
      mocks.createIdentity.mockResolvedValue(
        identity({ agentKey: 'plain', currentVersionId: null, id: 'plain-agent', status: 'draft' }),
      );
      await new PlatformAgentAdminService(db).create('admin-id', {
        agentKey: 'plain',
        isDefault: false,
        reason: 'normal create',
        systemKey: null,
      });
      expect(mocks.createIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: false, systemKey: null }),
      );
      // ADM-01: create enters the shared singleton lock before writing.
      expect(mocks.acquireDefaultLock).toHaveBeenCalledBefore(mocks.createIdentity);
    });

    it('rejects updateDraft that tries to promote to default', async () => {
      const locked = identity({ id: 'plain', isDefault: false, systemKey: null });
      mocks.lockIdentity.mockResolvedValue(locked);
      await expect(
        new PlatformAgentAdminService(db).updateDraft('admin-id', {
          ...pointer(locked),
          isDefault: true,
          reason: 'promote via updateDraft',
          systemKey: 'default-inbox',
        }),
      ).rejects.toBeInstanceOf(PlatformAgentInvalidInputError);
      expect(mocks.updateDraftCas).not.toHaveBeenCalled();
    });

    it('rejects updateDraft that tries to directly de-default', async () => {
      const locked = identity({ id: 'default-agent', isDefault: true, systemKey: 'default-inbox' });
      mocks.lockIdentity.mockResolvedValue(locked);
      await expect(
        new PlatformAgentAdminService(db).updateDraft('admin-id', {
          ...pointer(locked),
          isDefault: false,
          reason: 'drop default directly',
          systemKey: null,
        }),
      ).rejects.toBeInstanceOf(PlatformAgentInvalidInputError);
      expect(mocks.updateDraftCas).not.toHaveBeenCalled();
    });

    it('lets updateDraft touch a draft without carrying the default flag in the patch', async () => {
      const locked = identity({ id: 'plain', isDefault: false, systemKey: null });
      mocks.lockIdentity.mockResolvedValue(locked);
      mocks.updateDraftCas.mockResolvedValue({ ...locked, draftSequence: 5 });
      await new PlatformAgentAdminService(db).updateDraft('admin-id', {
        ...pointer(locked),
        isDefault: false,
        reason: 'touch',
        systemKey: null,
      });
      const patch = mocks.updateDraftCas.mock.calls[0]?.[0].patch;
      expect(patch).toEqual({ updatedBy: 'admin-id' });
      expect(patch).not.toHaveProperty('isDefault');
      expect(patch).not.toHaveProperty('systemKey');
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
});
