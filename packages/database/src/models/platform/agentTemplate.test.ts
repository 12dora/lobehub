// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAgentTemplates, platformTemplateCatalogState } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  PlatformAgentTemplateIdentifierConflictError,
  PlatformAgentTemplateModel,
} from './agentTemplate';
import { PlatformRevisionConflictError } from './errors';
import { PLATFORM_TEMPLATE_CATALOG_LEGACY_LOCALE } from './templateCatalogState';

const db: LobeChatDatabase = await getTestDB();
const model = new PlatformAgentTemplateModel(db);

const document = (overrides: Partial<Parameters<typeof model.create>[0]['document']> = {}) => ({
  avatar: null,
  backgroundColor: null,
  description: 'A short subtitle',
  enabled: true,
  systemRole: 'You are a helpful assistant.',
  tags: ['writing'],
  title: 'Writing mentor',
  ...overrides,
});

const create = (
  overrides: {
    document?: Partial<Parameters<typeof model.create>[0]['document']>;
    id?: string;
    identifier?: string;
    source?: 'manual' | 'builtin';
    sortOrder?: number;
  } = {},
) =>
  model.create({
    actorUserId: 'admin-a',
    document: document(overrides.document),
    id: overrides.id ?? crypto.randomUUID(),
    identifier: overrides.identifier ?? `tpl-${crypto.randomUUID().slice(0, 8)}`,
    source: overrides.source ?? 'manual',
    sortOrder: overrides.sortOrder,
  });

const cleanup = async () => {
  await db.delete(platformAgentTemplates);
  await db.delete(platformTemplateCatalogState);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformAgentTemplateModel', () => {
  it('reports zero while unused and lists nothing enabled', async () => {
    expect(await model.count()).toBe(0);
    expect(await model.listEnabled(10)).toEqual([]);
    expect(await model.findById('does-not-exist')).toBeUndefined();
  });

  it('creates, lists, and isolates one row from another', async () => {
    const first = await create({ identifier: 'first', document: { title: 'First' } });
    const second = await create({ identifier: 'second', document: { title: 'Second' } });

    expect(first.revision).toBe(1);
    expect(first.source).toBe('manual');
    expect(await model.count()).toBe(2);
    expect((await model.list({ limit: 20, offset: 0 })).items.map((row) => row.title)).toEqual([
      'First',
      'Second',
    ]);

    await model.delete({ expectedRevision: first.revision, id: first.id });
    expect(await model.findById(first.id)).toBeUndefined();
    expect(await model.findById(second.id)).toMatchObject({ title: 'Second' });
  });

  it('appends new rows to the end of the list', async () => {
    expect(await model.nextSortOrder()).toBe(0);
    const first = await create({ identifier: 'a' });
    const second = await create({ identifier: 'b' });
    expect(second.sortOrder).toBe(first.sortOrder + 1);
    expect(await model.nextSortOrder()).toBe(second.sortOrder + 1);
  });

  it('rejects a duplicate identifier as an input conflict', async () => {
    await create({ identifier: 'shared-slug' });
    await expect(create({ identifier: 'shared-slug' })).rejects.toBeInstanceOf(
      PlatformAgentTemplateIdentifierConflictError,
    );
    expect(await model.count()).toBe(1);
  });

  it('filters by enabled and query while still reporting the unfiltered total via list', async () => {
    await create({ identifier: 'alpha', document: { title: 'Alpha report' } });
    const beta = await create({ identifier: 'beta', document: { title: 'Beta report' } });
    await model.setEnabled({
      actorUserId: 'admin-a',
      enabled: false,
      expectedRevision: beta.revision,
      id: beta.id,
    });

    const enabledOnly = await model.list({ enabled: true, limit: 20, offset: 0 });
    expect(enabledOnly.items.map((row) => row.title)).toEqual(['Alpha report']);
    expect(enabledOnly.total).toBe(1);

    const searched = await model.list({ limit: 20, offset: 0, query: 'beta' });
    expect(searched.items.map((row) => row.title)).toEqual(['Beta report']);
    expect(searched.total).toBe(1);

    expect((await model.list({ limit: 20, offset: 0 })).total).toBe(2);
    expect((await model.listEnabled(10)).map((row) => row.title)).toEqual(['Alpha report']);
  });

  it('ORs identifiers into the query filter so list and count stay aligned', async () => {
    await create({ identifier: 'alpha', document: { title: 'Alpha report' } });
    await create({ identifier: 'beta', document: { title: 'Beta report' } });

    const missed = await model.list({
      identifiers: ['alpha'],
      limit: 20,
      offset: 0,
      query: 'does-not-match-stored-text',
    });
    expect(missed.items.map((row) => row.identifier)).toEqual(['alpha']);
    expect(missed.total).toBe(1);
    expect(await model.count({ identifiers: ['alpha'], query: 'does-not-match-stored-text' })).toBe(
      1,
    );

    const combined = await model.list({
      identifiers: ['alpha'],
      limit: 20,
      offset: 0,
      query: 'beta',
    });
    expect(combined.items.map((row) => row.identifier).toSorted()).toEqual(['alpha', 'beta']);
    expect(combined.total).toBe(2);
    expect(await model.count({ identifiers: ['alpha'], query: 'beta' })).toBe(2);

    const emptyIds = await model.list({
      identifiers: [],
      limit: 20,
      offset: 0,
      query: 'does-not-match-stored-text',
    });
    expect(emptyIds.items).toEqual([]);
    expect(emptyIds.total).toBe(0);
    expect(await model.count({ identifiers: [], query: 'does-not-match-stored-text' })).toBe(0);
  });

  it('caps listEnabled at the requested limit', async () => {
    for (let index = 0; index < 5; index += 1) {
      await create({ identifier: `row-${index}`, document: { title: `Row ${index}` } });
    }
    expect(await model.listEnabled(3)).toHaveLength(3);
  });

  it('updates content under CAS and rejects a stale revision', async () => {
    const created = await create();
    const next = await model.update({
      actorUserId: 'admin-b',
      document: document({ title: 'Edited' }),
      expectedRevision: created.revision,
      id: created.id,
    });
    expect(next.title).toBe('Edited');
    expect(next.revision).toBe(created.revision + 1);

    await expect(
      model.update({
        actorUserId: 'admin-c',
        document: document({ title: 'Stale' }),
        expectedRevision: created.revision,
        id: created.id,
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    expect((await model.findById(created.id))?.title).toBe('Edited');
  });

  it('toggles enabled and deletes under the same CAS', async () => {
    const created = await create();
    const disabled = await model.setEnabled({
      actorUserId: 'admin-a',
      enabled: false,
      expectedRevision: created.revision,
      id: created.id,
    });
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.title).toBe(created.title);

    await expect(
      model.setEnabled({
        actorUserId: 'admin-a',
        enabled: true,
        expectedRevision: created.revision,
        id: created.id,
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    expect(
      await model.setEnabled({
        actorUserId: 'admin-a',
        enabled: true,
        expectedRevision: 99,
        id: 'missing',
      }),
    ).toBeUndefined();
    expect(await model.delete({ expectedRevision: 1, id: 'missing' })).toBeUndefined();

    const removed = await model.delete({ expectedRevision: disabled!.revision, id: created.id });
    expect(removed?.id).toBe(created.id);
    expect(await model.count()).toBe(0);
  });

  it('reorders by redistributing occupied slots and rejects a stale drag as a whole', async () => {
    const first = await create({ identifier: 'first', document: { title: 'First' } });
    const second = await create({ identifier: 'second', document: { title: 'Second' } });
    const third = await create({ identifier: 'third', document: { title: 'Third' } });
    const slots = [first, second, third].map((row) => row.sortOrder).sort((a, b) => a - b);

    const reordered = await model.reorder({
      actorUserId: 'admin-a',
      items: [third, first, second].map((row) => ({
        expectedRevision: row.revision,
        id: row.id,
      })),
    });
    expect(reordered?.map((row) => row.title)).toEqual(['Third', 'First', 'Second']);
    expect(reordered?.map((row) => row.sortOrder).sort((a, b) => a - b)).toEqual(slots);

    await expect(
      model.reorder({
        actorUserId: 'admin-a',
        items: [
          { expectedRevision: first.revision, id: first.id },
          { expectedRevision: second.revision, id: second.id },
          { expectedRevision: third.revision, id: third.id },
        ],
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);

    expect(
      await model.reorder({
        actorUserId: 'admin-a',
        items: [
          { expectedRevision: 1, id: first.id },
          { expectedRevision: 1, id: 'missing' },
        ],
      }),
    ).toBeUndefined();
  });

  it('separates rows that share a legacy slot instead of collapsing the new order', async () => {
    const first = await create({ identifier: 'first', document: { title: 'First' } });
    const second = await create({ identifier: 'second', document: { title: 'Second' } });
    await db.update(platformAgentTemplates).set({ sortOrder: 0 });

    const result = await model.reorder({
      actorUserId: 'admin-a',
      items: [
        { expectedRevision: second.revision, id: second.id },
        { expectedRevision: first.revision, id: first.id },
      ],
    });
    expect(new Set(result?.map((row) => row.sortOrder)).size).toBe(2);
    expect(result?.map((row) => row.title)).toEqual(['Second', 'First']);
  });

  it('imports by identifier, preserves operator enabled/sortOrder, and is idempotent', async () => {
    const first = await model.importByIdentifier({
      actorUserId: 'admin-a',
      nextId: () => crypto.randomUUID(),
      rows: [
        {
          description: '',
          identifier: 'agent-01',
          systemRole: 'You are a writer.',
          title: 'Writer',
        },
        {
          description: '',
          identifier: 'agent-02',
          systemRole: 'You are a coach.',
          title: 'Coach',
        },
      ],
    });
    expect(first).toMatchObject({ created: 2, updated: 0 });
    expect(first.changes.every((change) => change.inserted)).toBe(true);

    const [imported] = (await model.list({ limit: 20, offset: 0 })).items;
    await model.setEnabled({
      actorUserId: 'admin-a',
      enabled: false,
      expectedRevision: imported!.revision,
      id: imported!.id,
    });
    const hiddenSort = (await model.findById(imported!.id))!.sortOrder;

    const second = await model.importByIdentifier({
      actorUserId: 'admin-b',
      nextId: () => crypto.randomUUID(),
      rows: [
        {
          description: 'refreshed',
          identifier: 'agent-01',
          systemRole: 'You are a better writer.',
          title: 'Writer v2',
        },
      ],
    });
    expect(second).toMatchObject({ created: 0, updated: 1 });
    expect(second.changes[0]?.inserted).toBe(false);
    expect(second.changes[0]?.before?.title).toBe('Writer');

    const refreshed = await model.findById(imported!.id);
    expect(refreshed).toMatchObject({
      enabled: false,
      identifier: 'agent-01',
      sortOrder: hiddenSort,
      source: 'builtin',
      title: 'Writer v2',
    });
    expect(await model.count()).toBe(2);
  });

  it('serializes first-time concurrent imports so the loser sees the winner as before', async () => {
    const run = () =>
      db.transaction(async (tx) => {
        const inner = new PlatformAgentTemplateModel(tx);
        return inner.importByIdentifier({
          actorUserId: 'admin-a',
          nextId: () => crypto.randomUUID(),
          rows: [
            {
              description: '',
              identifier: 'agent-01',
              systemRole: 'You are a writer.',
              title: 'Writer',
            },
          ],
        });
      });

    const [first, second] = await Promise.all([run(), run()]);
    expect(await model.count()).toBe(1);
    expect(first.created + second.created).toBe(1);
    expect(first.updated + second.updated).toBe(1);

    const winner = first.created === 1 ? first : second;
    const loser = first.updated === 1 ? first : second;
    expect(winner.changes[0]?.inserted).toBe(true);
    expect(winner.changes[0]?.before).toBeUndefined();
    expect(loser.changes[0]?.inserted).toBe(false);
    expect(loser.changes[0]?.before).toMatchObject({ identifier: 'agent-01', title: 'Writer' });
  });

  it('claims the catalog marker on create and never on a 404 delete', async () => {
    const created = await create({ identifier: 'claimed' });
    expect(await db.select().from(platformTemplateCatalogState)).toEqual([
      expect.objectContaining({
        domain: 'agent_templates',
        seededLocale: PLATFORM_TEMPLATE_CATALOG_LEGACY_LOCALE,
      }),
    ]);

    await db.delete(platformTemplateCatalogState);
    expect(await model.delete({ expectedRevision: 1, id: 'does-not-exist' })).toBeUndefined();
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(0);

    await model.delete({ expectedRevision: created.revision, id: created.id });
    expect(await db.select().from(platformTemplateCatalogState)).toEqual([
      expect.objectContaining({ domain: 'agent_templates' }),
    ]);
  });

  it('claims the catalog marker on update / setEnabled / reorder success, not on failure', async () => {
    const [raw] = await db
      .insert(platformAgentTemplates)
      .values({
        description: '',
        enabled: true,
        id: 'raw-1',
        identifier: 'raw-1',
        revision: 1,
        source: 'manual',
        systemRole: 'Keep me.',
        title: 'Raw',
      })
      .returning();
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(0);

    await model.update({
      actorUserId: 'admin-a',
      document: document({ title: 'Edited' }),
      expectedRevision: raw!.revision,
      id: raw!.id,
    });
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(1);

    await db.delete(platformTemplateCatalogState);
    await expect(
      model.update({
        actorUserId: 'admin-a',
        document: document({ title: 'Stale' }),
        expectedRevision: 0,
        id: raw!.id,
      }),
    ).rejects.toBeInstanceOf(PlatformRevisionConflictError);
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(0);

    const current = await model.findById(raw!.id);
    await model.setEnabled({
      actorUserId: 'admin-a',
      enabled: false,
      expectedRevision: current!.revision,
      id: current!.id,
    });
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(1);

    await db.delete(platformTemplateCatalogState);
    expect(
      await model.setEnabled({
        actorUserId: 'admin-a',
        enabled: true,
        expectedRevision: 1,
        id: 'does-not-exist',
      }),
    ).toBeUndefined();
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(0);

    const [second] = await db
      .insert(platformAgentTemplates)
      .values({
        description: '',
        enabled: true,
        id: 'raw-2',
        identifier: 'raw-2',
        revision: 1,
        sortOrder: 1,
        source: 'manual',
        systemRole: 'Keep me.',
        title: 'Second',
      })
      .returning();
    const first = await model.findById(raw!.id);
    await model.reorder({
      actorUserId: 'admin-a',
      items: [
        { expectedRevision: second!.revision, id: second!.id },
        { expectedRevision: first!.revision, id: first!.id },
      ],
    });
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(1);

    await db.delete(platformTemplateCatalogState);
    expect(
      await model.reorder({
        actorUserId: 'admin-a',
        items: [{ expectedRevision: 1, id: 'does-not-exist' }],
      }),
    ).toBeUndefined();
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(0);
  });

  it('insert-only import leaves an existing row untouched', async () => {
    await create({ identifier: 'agent-01', document: { title: 'Custom zh-CN' } });

    const result = await model.importByIdentifier({
      actorUserId: 'admin-b',
      nextId: () => crypto.randomUUID(),
      onConflict: 'nothing',
      rows: [
        {
          description: '',
          identifier: 'agent-01',
          systemRole: 'You are a writer.',
          title: 'Writer en-US',
        },
      ],
    });

    expect(result).toMatchObject({ created: 0, updated: 0 });
    expect((await model.list({ limit: 1, offset: 0 })).items[0]?.title).toBe('Custom zh-CN');
  });
});
