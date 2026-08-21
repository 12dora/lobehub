// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformTaskTemplates, platformTemplateCatalogState } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
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
