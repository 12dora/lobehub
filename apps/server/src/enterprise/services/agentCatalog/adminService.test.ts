import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase, Transaction } from '@/database/type';

import { PlatformAgentAdminService } from './adminService';
import { PlatformAgentDefaultRequiredError, PlatformAgentRevisionConflictError } from './errors';
import { platformAgentDraftToken } from './publication';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  appendAudit: vi.fn(),
  appendVersionCas: vi.fn(),
  archiveIdentityCas: vi.fn(),
  assertDependencies: vi.fn(),
  createAssignment: vi.fn(),
  getDefaultIdentityForUpdate: vi.fn(),
  getExactVersion: vi.fn(),
  getIdentity: vi.fn(),
  lockIdentity: vi.fn(),
  updateAssignment: vi.fn(),
  updateDraftCas: vi.fn(),
}));

vi.mock('@/database/repositories/platformAgentCatalog', () => ({
  PlatformAgentCatalogRepository: class {
    appendVersionCas = mocks.appendVersionCas;
    archiveIdentityCas = mocks.archiveIdentityCas;
    createAssignment = mocks.createAssignment;
    getDefaultIdentityForUpdate = mocks.getDefaultIdentityForUpdate;
    getExactVersion = mocks.getExactVersion;
    getIdentity = mocks.getIdentity;
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
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.agents.setDefaultInbox', result: 'success' }),
    );
  });

  it('requires a published replacement before archiving the current default', async () => {
    const current = identity({ id: 'default-agent', isDefault: true, systemKey: 'default-inbox' });
    mocks.lockIdentity.mockResolvedValue(current);
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
});
