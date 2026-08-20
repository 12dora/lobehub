// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformTaskTemplates } from '../../schemas/platform';
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
});
