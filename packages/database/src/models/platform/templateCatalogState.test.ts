// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformTemplateCatalogState } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformTemplateCatalogStateModel } from './templateCatalogState';

const db: LobeChatDatabase = await getTestDB();
const model = new PlatformTemplateCatalogStateModel(db);

const cleanup = async () => {
  await db.delete(platformTemplateCatalogState);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformTemplateCatalogStateModel', () => {
  it('returns undefined until a domain is marked seeded', async () => {
    expect(await model.findSeeded('agent_templates')).toBeUndefined();
    expect(await model.findSeeded('task_templates')).toBeUndefined();
  });

  it('records locale and actor on first mark and isolates domains', async () => {
    const agents = await model.markSeeded({
      domain: 'agent_templates',
      seededBy: 'admin-a',
      seededLocale: 'zh-CN',
    });

    expect(agents.domain).toBe('agent_templates');
    expect(agents.seededLocale).toBe('zh-CN');
    expect(agents.seededBy).toBe('admin-a');
    expect(agents.seededAt).toBeInstanceOf(Date);
    expect(await model.findSeeded('task_templates')).toBeUndefined();

    const tasks = await model.markSeeded({
      domain: 'task_templates',
      seededBy: null,
      seededLocale: 'en-US',
    });
    expect(tasks.seededBy).toBeNull();
    expect(tasks.seededLocale).toBe('en-US');
    expect(await model.findSeeded('agent_templates')).toMatchObject({ seededLocale: 'zh-CN' });
  });

  it('is idempotent: a second mark keeps the winner and does not overwrite locale', async () => {
    const first = await model.markSeeded({
      domain: 'agent_templates',
      seededBy: 'admin-a',
      seededLocale: 'ja-JP',
    });
    const second = await model.markSeeded({
      domain: 'agent_templates',
      seededBy: 'admin-b',
      seededLocale: 'en-US',
    });

    expect(second.seededLocale).toBe('ja-JP');
    expect(second.seededBy).toBe('admin-a');
    expect(second.seededAt.getTime()).toBe(first.seededAt.getTime());
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(1);
  });
});
