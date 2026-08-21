// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformTaskTemplates, platformTemplateCatalogState } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformRevisionConflictError } from './errors';
import { PlatformTaskTemplateModel } from './taskTemplate';

const db: LobeChatDatabase = await getTestDB();
const model = new PlatformTaskTemplateModel(db);

const importRow = {
  category: 'engineering',
  connectors: [] as { identifier: string; required: boolean; source: 'lobehub' }[],
  cronPattern: '0 9 * * *',
  description: 'Market description',
  icon: null,
  identifier: 'market-daily',
  instruction: 'Market instruction',
  interests: ['coding'],
  title: 'Market title',
};

const cleanup = async () => {
  await db.delete(platformTaskTemplates);
  await db.delete(platformTemplateCatalogState);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformTaskTemplateModel.importByIdentifier', () => {
  it('serializes first-time concurrent imports so the loser sees the winner as before', async () => {
    const run = () =>
      db.transaction(async (tx) => {
        const inner = new PlatformTaskTemplateModel(tx);
        return inner.importByIdentifier({
          actorUserId: 'admin-a',
          nextId: () => crypto.randomUUID(),
          rows: [importRow],
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
    expect(loser.changes[0]?.before).toMatchObject({
      identifier: 'market-daily',
      title: 'Market title',
    });
  });

  it('claims the catalog marker on a successful delete, never on a 404', async () => {
    const created = await model.create({
      actorUserId: 'admin-a',
      document: {
        category: 'engineering',
        connectors: [],
        cronPattern: '0 9 * * *',
        description: '',
        enabled: true,
        icon: null,
        instruction: 'Keep me.',
        interests: ['coding'],
        title: 'Custom',
      },
      id: crypto.randomUUID(),
      identifier: 'claimed',
      source: 'manual',
    });
    await db.delete(platformTemplateCatalogState);

    expect(await model.delete({ expectedRevision: 1, id: 'does-not-exist' })).toBeUndefined();
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(0);

    await model.delete({ expectedRevision: created.revision, id: created.id });
    expect(await db.select().from(platformTemplateCatalogState)).toEqual([
      expect.objectContaining({ domain: 'task_templates' }),
    ]);
  });

  it('claims the catalog marker on update / setEnabled / reorder success, not on failure', async () => {
    const document = {
      category: 'engineering' as const,
      connectors: [] as { identifier: string; required: boolean; source: 'lobehub' }[],
      cronPattern: '0 9 * * *',
      description: '',
      enabled: true,
      icon: null,
      instruction: 'Keep me.',
      interests: ['coding'],
      title: 'Raw',
    };
    const [raw] = await db
      .insert(platformTaskTemplates)
      .values({
        ...document,
        id: 'raw-1',
        identifier: 'raw-1',
        revision: 1,
        source: 'manual',
      })
      .returning();
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(0);

    await model.update({
      actorUserId: 'admin-a',
      document: { ...document, title: 'Edited' },
      expectedRevision: raw!.revision,
      id: raw!.id,
    });
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(1);

    await db.delete(platformTemplateCatalogState);
    await expect(
      model.update({
        actorUserId: 'admin-a',
        document: { ...document, title: 'Stale' },
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
      .insert(platformTaskTemplates)
      .values({
        ...document,
        id: 'raw-2',
        identifier: 'raw-2',
        revision: 1,
        sortOrder: 1,
        source: 'manual',
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
    await model.create({
      actorUserId: 'admin-a',
      document: {
        category: 'engineering',
        connectors: [],
        cronPattern: '0 9 * * *',
        description: '',
        enabled: true,
        icon: null,
        instruction: 'Keep me.',
        interests: ['coding'],
        title: 'Custom zh-CN',
      },
      id: crypto.randomUUID(),
      identifier: 'market-daily',
      source: 'manual',
    });

    const result = await model.importByIdentifier({
      actorUserId: 'admin-b',
      nextId: () => crypto.randomUUID(),
      onConflict: 'nothing',
      rows: [{ ...importRow, title: 'Market title en-US' }],
    });

    expect(result).toMatchObject({ created: 0, updated: 0 });
    expect((await model.list({ limit: 1, offset: 0 })).items[0]?.title).toBe('Custom zh-CN');
  });
});
