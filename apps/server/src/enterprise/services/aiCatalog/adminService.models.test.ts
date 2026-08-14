// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformRevisionConflictError } from '@/database/models/platform';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import {
  platformAgents,
  platformAgentVersions,
  platformAiModels,
  platformAiProviders,
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogAdminService, AiCatalogResourceInUseError } from './adminService';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(29), keyId: 'model-test' }),
  providerId: 'test',
};
const service = new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }));
const AGENT_DEPENDENCY_CHECKSUM = 'b'.repeat(64);
const agentConfig = {
  avatar: null,
  backgroundColor: null,
  description: 'Exact AI dependent',
  displayName: 'Exact AI dependent',
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Use the exact model dependency.',
  tags: [],
};

const createPublishedAgentDependency = async (params: {
  agentKey: string;
  modelKey: string;
  providerKey: string;
}) => {
  const repository = new PlatformAgentCatalogRepository(db);
  const agent = await repository.createIdentity({
    agentKey: params.agentKey,
    isDefault: false,
    systemKey: null,
  });
  const version = await repository.appendVersionCas({
    agentId: agent.id,
    config: agentConfig,
    dependencySnapshot: {
      connectors: [],
      model: {
        modelKey: params.modelKey,
        providerChecksum: AGENT_DEPENDENCY_CHECKSUM,
        providerKey: params.providerKey,
        providerRevision: 1,
      },
      skills: [],
    },
    expectedDraftSequence: 0,
    expectedRevision: 0,
    version: '1.0.0',
  });
  await repository.pointToVersionCas({
    agentId: agent.id,
    expectedDraftSequence: 1,
    expectedRevision: 0,
    publishedAt: new Date(),
    versionId: version!.id,
  });
  await db
    .update(platformAgents)
    .set({ model: 'legacy-poison-model', provider: 'legacy-poison-provider' })
    .where(eq(platformAgents.id, agent.id));
  return agent;
};

const cleanup = async () => {
  // Migration 0145: audit logs are append-only; TRUNCATE bypasses the row trigger.
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformAgentVersions},
      ${platformAgents},
      ${platformSettingPolicies},
      ${platformAiModels},
      ${platformAiProviders}
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(cleanup);
afterEach(cleanup);

const createProviderAndModels = async () => {
  const provider = await service.createProviderDraft('admin', {
    displayName: 'Alpha',
    providerKey: 'alpha',
    reason: 'create',
    source: 'custom',
  });
  let detail = await service.getDetail(provider.id);
  const first = await service.createModel('admin', {
    enabled: true,
    expectedDraftToken: detail.draftToken,
    modelKey: 'first',
    providerId: provider.id,
    reason: 'first model',
    sort: 1,
  });
  detail = await service.getDetail(provider.id);
  const second = await service.createModel('admin', {
    enabled: true,
    expectedDraftToken: detail.draftToken,
    modelKey: 'second',
    providerId: provider.id,
    reason: 'second model',
    sort: 2,
  });
  return { first, provider, second };
};

describe('AiCatalogAdminService model mutations', () => {
  it('rejects copying kept provider credential leaves into model fields', async () => {
    const credential = 'arbitrary-model-credential-leaf';
    const provider = await service.createProviderDraft('admin', {
      displayName: 'Credential boundary',
      providerKey: 'credential-boundary',
      reason: 'create',
      secret: { operation: 'replace', value: { apiKey: credential } },
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    await expect(
      service.createModel('admin', {
        description: `copied ${credential}`,
        expectedDraftToken: detail.draftToken,
        modelKey: 'rejected',
        providerId: provider.id,
        reason: 'create rejected model',
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
    expect(await db.select().from(platformAiModels)).toEqual([]);

    const model = await service.createModel('admin', {
      expectedDraftToken: detail.draftToken,
      modelKey: 'safe-model',
      providerId: provider.id,
      reason: 'create safe model',
    });
    detail = await service.getDetail(provider.id);
    await expect(
      service.updateModel('admin', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: model.id,
        providerId: provider.id,
        reason: 'update rejected model',
        settings: { publicNote: credential },
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
    expect((await service.getDetail(provider.id)).draft.models[0].settings).toEqual({});

    detail = await service.getDetail(provider.id);
    await expect(
      service.createModel('admin', {
        config: { documentationUrl: 'https://example.test/model?sig=unrelated-signature' },
        expectedDraftToken: detail.draftToken,
        modelKey: 'signed-url-model',
        providerId: provider.id,
        reason: 'reject signed model URL',
      }),
    ).rejects.toMatchObject({
      issues: ['Provider credentials must not appear in public catalog fields'],
    });
  });

  it('reorder fails closed unless items exactly equal the complete locked provider collection', async () => {
    const { first, provider, second } = await createProviderAndModels();
    const detail = await service.getDetail(provider.id);

    await expect(
      service.reorderModels('admin', {
        expectedDraftToken: detail.draftToken,
        items: [{ id: first.id, sort: 9 }],
        providerId: provider.id,
        reason: 'incomplete reorder',
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect(
      (await db.select().from(platformAiModels).orderBy(platformAiModels.modelKey)).map(
        (row) => row.sort,
      ),
    ).toEqual([1, 2]);

    const complete = await service.reorderModels('admin', {
      expectedDraftToken: detail.draftToken,
      items: [
        { id: first.id, sort: 2 },
        { id: second.id, sort: 1 },
      ],
      providerId: provider.id,
      reason: 'complete reorder',
    });
    expect(complete.updated).toBe(2);
    expect(complete.draftToken).toHaveLength(64);
    expect(
      (await db.select().from(platformAiModels).orderBy(platformAiModels.modelKey)).map(
        (row) => row.sort,
      ),
    ).toEqual([2, 1]);
  });

  it('blocks disabling/deleting models referenced by published agents or settings', async () => {
    const { first, provider, second } = await createProviderAndModels();
    const dependentAgent = await createPublishedAgentDependency({
      agentKey: 'default-agent',
      modelKey: first.modelKey,
      providerKey: provider.providerKey,
    });
    await new PlatformAgentCatalogRepository(db).appendVersionCas({
      agentId: dependentAgent.id,
      config: agentConfig,
      dependencySnapshot: {
        connectors: [],
        model: {
          modelKey: second.modelKey,
          providerChecksum: AGENT_DEPENDENCY_CHECKSUM,
          providerKey: provider.providerKey,
          providerRevision: 2,
        },
        skills: [],
      },
      expectedDraftSequence: 2,
      expectedRevision: 1,
      version: '2.0.0',
    });
    expect(await service.getDependents(provider.id, second.id)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: dependentAgent.id, resourceType: 'agent' }),
      ]),
    );
    await db.insert(platformSettingPolicies).values([
      {
        mode: 'locked',
        path: 'defaultAgent.config.model',
        status: 'published',
        value: { model: first.modelKey, provider: provider.providerKey },
        visibility: 'visible',
      },
      {
        mode: 'locked',
        path: 'systemAgent.topic.model',
        status: 'published',
        value: first.modelKey,
        visibility: 'visible',
      },
      {
        mode: 'locked',
        path: 'systemAgent.topic.provider',
        status: 'published',
        value: provider.providerKey,
        visibility: 'visible',
      },
    ]);

    const dependents = await service.getDependents(provider.id, first.id);
    expect(dependents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: 'agent' }),
        expect.objectContaining({ resourceType: 'setting' }),
        expect.objectContaining({ label: 'systemAgent.topic', resourceType: 'setting' }),
      ]),
    );
    const detail = await service.getDetail(provider.id);
    await expect(
      service.updateModel('admin', {
        enabled: false,
        expectedDraftToken: detail.draftToken,
        expectedRevision: 0,
        id: first.id,
        providerId: provider.id,
        reason: 'disable in-use',
      }),
    ).rejects.toBeInstanceOf(AiCatalogResourceInUseError);
    await expect(
      service.deleteModel('admin', {
        expectedDraftToken: detail.draftToken,
        id: first.id,
        providerId: provider.id,
        reason: 'delete in-use',
      }),
    ).rejects.toBeInstanceOf(AiCatalogResourceInUseError);
    expect(
      (await db.select().from(platformAiModels).where(eq(platformAiModels.id, first.id)))[0]
        .enabled,
    ).toBe(true);
  });

  /**
   * Count real drizzle DML entry-points on the transaction object (tx.update/insert/delete),
   * not helper-function invocations. Sequential per-item paths issue one model UPDATE per id;
   * bulk paths issue a single multi-row UPDATE for the unique set.
   *
   * `applyModelImmediate` nests three transactions: the outer atomic apply (index 0), the model
   * mutation savepoint (index 1) and the publish savepoint (index 2). Counters are scoped to the
   * mutation savepoint — the publish materialization (delete + re-insert of model rows from the
   * revision payload) is not what these assertions are about.
   */
  const withTxDmlCounters = async <T>(run: () => Promise<T>) => {
    const counters = {
      modelDeletes: 0,
      modelInserts: 0,
      modelUpdates: 0,
      auditInserts: 0,
    };
    // Only the first savepoint (the model mutation) is counted; the second is the publish.
    let nestedIndex = 0;
    let counting = false;
    type CountableTx = {
      delete: (table: unknown, ...args: unknown[]) => unknown;
      insert: (table: unknown, ...args: unknown[]) => unknown;
      transaction: (callback: (tx: unknown) => unknown, ...rest: unknown[]) => unknown;
      update: (table: unknown, ...args: unknown[]) => unknown;
    };
    const instrument = (handle: unknown) => {
      const tx = handle as CountableTx;
      const rawUpdate = tx.update.bind(tx);
      const rawInsert = tx.insert.bind(tx);
      const rawDelete = tx.delete.bind(tx);
      const rawTransaction = tx.transaction.bind(tx);
      tx.update = (table, ...args) => {
        if (counting && table === platformAiModels) counters.modelUpdates += 1;
        return rawUpdate(table, ...args);
      };
      tx.insert = (table, ...args) => {
        if (counting && table === platformAiModels) counters.modelInserts += 1;
        if (counting && table === platformAuditLogs) counters.auditInserts += 1;
        return rawInsert(table, ...args);
      };
      tx.delete = (table, ...args) => {
        if (counting && table === platformAiModels) counters.modelDeletes += 1;
        return rawDelete(table, ...args);
      };
      // Savepoints get their own handle — instrument it too, or nested DML is invisible.
      tx.transaction = (callback, ...rest) =>
        rawTransaction(
          async (child: unknown) => {
            const index = nestedIndex++;
            instrument(child);
            const previous = counting;
            counting = index === 0;
            try {
              return await callback(child);
            } finally {
              counting = previous;
            }
          },
          ...rest,
        );
    };

    const originalTransaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((
      callback: Parameters<typeof db.transaction>[0],
      ...rest: unknown[]
    ) =>
      originalTransaction(
        async (tx) => {
          instrument(tx);
          return callback(tx);
        },
        ...(rest as []),
      )) as typeof db.transaction);

    try {
      const result = await run();
      return { counters, result };
    } finally {
      spy.mockRestore();
    }
  };

  it('batchToggle uses bounded bulk DML and matches per-item enabled outcomes', async () => {
    const provider = await service.createProviderDraft('admin', {
      displayName: 'Bulk Toggle',
      providerKey: 'bulk-toggle',
      reason: 'create',
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    const modelCount = 12;
    const modelIds: string[] = [];
    for (let i = 0; i < modelCount; i += 1) {
      const created = await service.createModel('admin', {
        enabled: true,
        expectedDraftToken: detail.draftToken,
        modelKey: `m-${i}`,
        providerId: provider.id,
        reason: `model ${i}`,
        sort: i,
      });
      modelIds.push(created.id);
      detail = await service.getDetail(provider.id);
    }

    const { counters } = await withTxDmlCounters(() =>
      service.applyModelImmediate('admin', {
        enabled: false,
        expectedDraftToken: detail.draftToken,
        modelIds,
        operation: 'batchToggle',
        providerId: provider.id,
        reason: 'bulk toggle off',
      }),
    );

    // Real SQL reduction: one multi-row model UPDATE, not N per-id updates.
    expect(counters.modelUpdates).toBe(1);
    expect(counters.modelUpdates).toBeLessThan(modelCount);
    // One multi-row audit insert (chunked) rather than N single-row inserts.
    expect(counters.auditInserts).toBe(1);

    const after = await service.getDetail(provider.id);
    expect(after.draft.models).toHaveLength(modelCount);
    expect(after.draft.models.every((model) => model.enabled === false)).toBe(true);

    const batchAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiModels.update' && row.reason === 'bulk toggle off',
    );
    expect(batchAudits).toHaveLength(modelCount);
  });

  it('batchToggle with duplicate ids matches sequential final state and per-item audits', async () => {
    const provider = await service.createProviderDraft('admin', {
      displayName: 'Dup Toggle',
      providerKey: 'dup-toggle',
      reason: 'create',
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    const first = await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'dup-a',
      providerId: provider.id,
      reason: 'a',
      sort: 0,
    });
    detail = await service.getDetail(provider.id);
    const second = await service.createModel('admin', {
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'dup-b',
      providerId: provider.id,
      reason: 'b',
      sort: 1,
    });
    detail = await service.getDetail(provider.id);

    // Schema permits duplicates; legacy sequential path toggled each entry and audited each.
    const modelIds = [first.id, second.id, first.id];
    const { counters } = await withTxDmlCounters(() =>
      service.applyModelImmediate('admin', {
        enabled: false,
        expectedDraftToken: detail.draftToken,
        modelIds,
        operation: 'batchToggle',
        providerId: provider.id,
        reason: 'dup toggle off',
      }),
    );

    // Unique DML only — never throw on RETURNING vs raw input length.
    expect(counters.modelUpdates).toBe(1);
    expect(counters.auditInserts).toBe(1);

    const after = await service.getDetail(provider.id);
    expect(after.draft.models).toHaveLength(2);
    expect(after.draft.models.every((model) => model.enabled === false)).toBe(true);

    const audits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiModels.update' && row.reason === 'dup toggle off',
    );
    // Per-input audits (3), not unique-id count (2).
    expect(audits).toHaveLength(3);
    expect(audits.map((row) => row.targetId).sort()).toEqual(
      [first.id, first.id, second.id].sort(),
    );
  });

  it('batchUpdate bulk path creates and updates with identical final state and fewer statements', async () => {
    const provider = await service.createProviderDraft('admin', {
      displayName: 'Bulk Update',
      providerKey: 'bulk-update',
      reason: 'create',
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    const existing: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const created = await service.createModel('admin', {
        displayName: `Old ${i}`,
        enabled: true,
        expectedDraftToken: detail.draftToken,
        modelKey: `existing-${i}`,
        providerId: provider.id,
        reason: `seed ${i}`,
        sort: i,
      });
      existing.push(created.id);
      detail = await service.getDetail(provider.id);
    }

    const { counters } = await withTxDmlCounters(() =>
      service.applyModelImmediate('admin', {
        expectedDraftToken: detail.draftToken,
        models: [
          ...existing.map((id, index) => ({
            displayName: `Renamed ${index}`,
            id,
          })),
          {
            displayName: 'Brand New',
            enabled: true,
            id: 'brand-new-key',
            type: 'chat' as const,
          },
        ],
        operation: 'batchUpdate',
        providerId: provider.id,
        reason: 'bulk update mixed',
      }),
    );

    // 1 multi-row model INSERT + 1 multi-row model UPDATE (not 7 per-item DML statements).
    expect(counters.modelInserts).toBe(1);
    expect(counters.modelUpdates).toBe(1);
    expect(counters.modelInserts + counters.modelUpdates).toBeLessThan(7);
    expect(counters.auditInserts).toBe(1);

    const after = await service.getDetail(provider.id);
    expect(after.draft.models).toHaveLength(7);
    expect(
      after.draft.models
        .filter((model) => model.modelKey.startsWith('existing-'))
        .map((model) => model.displayName)
        .sort(),
    ).toEqual(['Renamed 0', 'Renamed 1', 'Renamed 2', 'Renamed 3', 'Renamed 4', 'Renamed 5']);
    expect(after.draft.models.find((model) => model.modelKey === 'brand-new-key')).toMatchObject({
      displayName: 'Brand New',
      enabled: true,
      type: 'chat',
    });

    const logs = await db.select().from(platformAuditLogs);
    expect(
      logs.filter(
        (row) => row.action === 'admin.aiModels.create' && row.reason === 'bulk update mixed',
      ),
    ).toHaveLength(1);
    expect(
      logs.filter(
        (row) => row.action === 'admin.aiModels.update' && row.reason === 'bulk update mixed',
      ),
    ).toHaveLength(6);
  });

  it('batchUpdate with duplicate ids composes last-wins and keeps per-item audits', async () => {
    const provider = await service.createProviderDraft('admin', {
      displayName: 'Dup Update',
      providerKey: 'dup-update',
      reason: 'create',
      source: 'custom',
    });
    let detail = await service.getDetail(provider.id);
    const model = await service.createModel('admin', {
      displayName: 'Original',
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'dup-target',
      providerId: provider.id,
      reason: 'seed',
      sort: 0,
    });
    detail = await service.getDetail(provider.id);

    const { counters } = await withTxDmlCounters(() =>
      service.applyModelImmediate('admin', {
        expectedDraftToken: detail.draftToken,
        models: [
          { displayName: 'First rename', id: model.id },
          { displayName: 'Second rename', enabled: false, id: model.id },
        ],
        operation: 'batchUpdate',
        providerId: provider.id,
        reason: 'dup update compose',
      }),
    );

    // One unique-id UPDATE statement even though input listed the id twice.
    expect(counters.modelUpdates).toBe(1);
    expect(counters.auditInserts).toBe(1);

    const after = await service.getDetail(provider.id);
    const row = after.draft.models.find((item) => item.id === model.id);
    // Sequential composition: first rename then second rename + disable.
    expect(row).toMatchObject({
      displayName: 'Second rename',
      enabled: false,
    });

    const audits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiModels.update' && row.reason === 'dup update compose',
    );
    expect(audits).toHaveLength(2);
    expect(audits.every((entry) => entry.targetId === model.id)).toBe(true);
  });

  it('clear uses bulk delete instead of per-model DML and keeps per-item audits', async () => {
    const { first, provider, second } = await createProviderAndModels();
    const detail = await service.getDetail(provider.id);

    const { counters } = await withTxDmlCounters(() =>
      service.applyModelImmediate('admin', {
        expectedDraftToken: detail.draftToken,
        operation: 'clear',
        providerId: provider.id,
        reason: 'bulk clear',
      }),
    );

    expect(counters.modelDeletes).toBe(1);
    expect(counters.auditInserts).toBe(1);

    const after = await service.getDetail(provider.id);
    expect(after.draft.models).toEqual([]);
    const deleteAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiModels.deleteFromDraft' && row.reason === 'bulk clear',
    );
    expect(deleteAudits).toHaveLength(2);
    expect(deleteAudits.map((row) => row.targetId).sort()).toEqual([first.id, second.id].sort());
  });
});
