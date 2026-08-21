// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformAgentTemplateModel, PlatformTaskTemplateModel } from '@/database/models/platform';
import {
  platformAgentTemplates,
  platformTaskTemplates,
  platformTemplateCatalogState,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import type * as AgentTemplatesSupportModule from '../routers/admin/agentTemplatesSupport';
import type * as TaskTemplatesSupportModule from '../routers/admin/taskTemplatesSupport';

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  fetchAgents: vi.fn(),
  fetchTasks: vi.fn(),
}));

vi.mock('./platformAudit', () => ({
  PlatformAuditService: class {
    append = mocks.append;
  },
}));

vi.mock('../routers/admin/agentTemplatesSupport', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentTemplatesSupportModule>();
  return {
    ...actual,
    fetchBuiltInAgentTemplatesForImport: (params: { locale?: string }) => mocks.fetchAgents(params),
  };
});

vi.mock('../routers/admin/taskTemplatesSupport', async (importOriginal) => {
  const actual = await importOriginal<typeof TaskTemplatesSupportModule>();
  return {
    ...actual,
    fetchLibraryTaskTemplatesForImport: (params: { locale?: string; userId: string }) =>
      mocks.fetchTasks(params),
  };
});

const { ensureAgentTemplateCatalogSeeded, ensureTaskTemplateCatalogSeeded } =
  await import('./templateCatalogBootstrap');

const db: LobeChatDatabase = await getTestDB();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const agentRow = (locale?: string) => ({
  description: '',
  identifier: 'agent-01',
  systemRole: 'You are a writer.',
  title: locale === 'zh-CN' ? '写作导师' : 'Writer',
});

const taskRow = (locale?: string) => ({
  category: 'engineering' as const,
  connectors: [],
  cronPattern: '0 9 * * *',
  description: 'Market description',
  icon: null,
  identifier: 'market-daily',
  instruction: 'Market instruction',
  interests: ['coding'] as const,
  title: locale === 'zh-CN' ? '工程日报' : 'Market title',
});

const cleanup = async () => {
  await db.delete(platformAgentTemplates);
  await db.delete(platformTaskTemplates);
  await db.delete(platformTemplateCatalogState);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  mocks.append.mockReset();
  mocks.append.mockResolvedValue({ action: 'seed', id: 'audit-ok', result: 'success' });
  mocks.fetchAgents.mockReset();
  mocks.fetchAgents.mockImplementation((params: { locale?: string } = {}) => ({
    rows: [agentRow(params.locale)],
    skipped: 0,
  }));
  mocks.fetchTasks.mockReset();
  mocks.fetchTasks.mockImplementation((params: { locale?: string } = {}) => ({
    rows: [taskRow(params.locale)],
    skipped: 0,
  }));
  await cleanup();
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('ensureAgentTemplateCatalogSeeded', () => {
  it('imports builtins on a fresh catalog and writes a marker plus auto_seed audit', async () => {
    await ensureAgentTemplateCatalogSeeded(db, { actorUserId: 'admin-1', locale: 'en-US' });

    const rows = await db.select().from(platformAgentTemplates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toBe('agent-01');
    expect(rows[0]?.id).toMatch(UUID_RE);
    expect(rows[0]?.source).toBe('builtin');

    const [marker] = await db.select().from(platformTemplateCatalogState);
    expect(marker).toMatchObject({
      domain: 'agent_templates',
      seededBy: 'admin-1',
      seededLocale: 'en-US',
    });
    expect(mocks.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.agentTemplates.importBuiltins',
        actorUserId: 'admin-1',
        afterDiff: expect.objectContaining({ created: 1, reason: 'auto_seed', updated: 0 }),
      }),
    );
  });

  it('is a no-op once the marker exists, even if the table is emptied', async () => {
    await ensureAgentTemplateCatalogSeeded(db);
    await db.delete(platformAgentTemplates);
    mocks.append.mockClear();
    mocks.fetchAgents.mockClear();

    await ensureAgentTemplateCatalogSeeded(db, { locale: 'zh-CN' });

    expect(await db.select().from(platformAgentTemplates)).toHaveLength(0);
    expect(mocks.fetchAgents).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(1);
  });

  it('writes a marker only when rows already exist and never overwrites them', async () => {
    await db.insert(platformAgentTemplates).values({
      description: '',
      enabled: true,
      id: 'existing',
      identifier: 'custom-row',
      revision: 1,
      source: 'manual',
      systemRole: 'Keep me.',
      title: 'Custom',
    });

    await ensureAgentTemplateCatalogSeeded(db, { locale: 'ja-JP' });

    const rows = await db.select().from(platformAgentTemplates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toBe('custom-row');
    expect(mocks.fetchAgents).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(await db.select().from(platformTemplateCatalogState)).toEqual([
      expect.objectContaining({ domain: 'agent_templates', seededLocale: 'ja-JP' }),
    ]);
  });

  it('does not duplicate rows when two callers race the first seed', async () => {
    await Promise.all([
      ensureAgentTemplateCatalogSeeded(db, { locale: 'en-US' }),
      ensureAgentTemplateCatalogSeeded(db, { locale: 'zh-CN' }),
    ]);

    expect(await db.select().from(platformAgentTemplates)).toHaveLength(1);
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(1);
  });

  it('resolves locale as explicit arg, then DEFAULT_LANG env, then en-US', async () => {
    await ensureAgentTemplateCatalogSeeded(db, { locale: 'zh-CN' });
    expect(mocks.fetchAgents).toHaveBeenCalledWith({ locale: 'zh-CN' });
    expect((await db.select().from(platformAgentTemplates))[0]?.title).toBe('写作导师');

    await db.delete(platformAgentTemplates);
    await db.delete(platformTemplateCatalogState);
    mocks.fetchAgents.mockClear();
    vi.stubEnv('DEFAULT_LANG', 'zh-CN');

    await ensureAgentTemplateCatalogSeeded(db);
    expect(mocks.fetchAgents).toHaveBeenCalledWith({ locale: 'zh-CN' });

    await db.delete(platformAgentTemplates);
    await db.delete(platformTemplateCatalogState);
    vi.stubEnv('DEFAULT_LANG', '');
    mocks.fetchAgents.mockClear();

    await ensureAgentTemplateCatalogSeeded(db);
    expect(mocks.fetchAgents).toHaveBeenCalledWith({ locale: 'en-US' });
  });

  it('records a null actor on startup-style seed', async () => {
    await ensureAgentTemplateCatalogSeeded(db);

    expect(mocks.append).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: null,
        afterDiff: expect.objectContaining({ reason: 'auto_seed' }),
      }),
    );
    expect((await db.select().from(platformTemplateCatalogState))[0]?.seededBy).toBeNull();
  });

  it('does not overwrite a same-identifier row (insert-only)', async () => {
    await db.insert(platformAgentTemplates).values({
      description: '',
      enabled: true,
      id: 'existing',
      identifier: 'agent-01',
      revision: 1,
      source: 'manual',
      systemRole: 'Keep me.',
      title: 'Custom zh-CN',
    });

    await ensureAgentTemplateCatalogSeeded(db, { locale: 'en-US' });

    const rows = await db.select().from(platformAgentTemplates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Custom zh-CN');
    expect(mocks.fetchAgents).not.toHaveBeenCalled();
  });

  it('backfills a marker for a populated catalog so delete-all does not re-seed', async () => {
    await db.insert(platformAgentTemplates).values({
      description: '',
      enabled: true,
      id: 'upgrade-row',
      identifier: 'custom-row',
      revision: 1,
      source: 'manual',
      systemRole: 'Keep me.',
      title: 'Custom',
    });
    await db.delete(platformTemplateCatalogState);

    await db.execute(sql`
      INSERT INTO "platform_template_catalog_state" ("domain", "seeded_locale", "seeded_by")
      SELECT 'agent_templates', 'legacy', NULL
      WHERE EXISTS (SELECT 1 FROM "platform_agent_templates")
      ON CONFLICT ("domain") DO NOTHING
    `);

    await db.delete(platformAgentTemplates);
    mocks.fetchAgents.mockClear();
    await ensureAgentTemplateCatalogSeeded(db, { locale: 'en-US' });

    expect(await db.select().from(platformAgentTemplates)).toHaveLength(0);
    expect(mocks.fetchAgents).not.toHaveBeenCalled();
  });
});

const isServerDB = process.env.TEST_SERVER_DB === '1';

describe.skipIf(!isServerDB)('template catalog lock races (TEST_SERVER_DB=1)', () => {
  it('seed vs import does not overwrite imported localized content', async () => {
    await Promise.all([
      ensureAgentTemplateCatalogSeeded(db, { locale: 'en-US' }),
      db.transaction(async (tx) => {
        await new PlatformAgentTemplateModel(tx).importByIdentifier({
          actorUserId: 'admin-zh',
          nextId: () => crypto.randomUUID(),
          rows: [agentRow('zh-CN')],
          seededLocale: 'zh-CN',
        });
      }),
    ]);

    const rows = await db.select().from(platformAgentTemplates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toBe('agent-01');
    // Import upserts, so a completed import always wins the title. Seed is insert-only.
    expect(rows[0]?.title).toBe('写作导师');
  });

  it('seed vs create never drops the created row or overwrites it', async () => {
    await Promise.all([
      ensureAgentTemplateCatalogSeeded(db, { locale: 'en-US' }),
      db.transaction(async (tx) => {
        await new PlatformAgentTemplateModel(tx).create({
          actorUserId: 'admin-a',
          document: {
            avatar: null,
            backgroundColor: null,
            description: '',
            enabled: true,
            systemRole: 'Keep me.',
            tags: [],
            title: 'Custom',
          },
          id: crypto.randomUUID(),
          identifier: 'custom-row',
          source: 'manual',
        });
      }),
    ]);

    const identifiers = (await db.select().from(platformAgentTemplates))
      .map((row) => row.identifier)
      .toSorted();
    expect(identifiers.includes('custom-row')).toBe(true);
    expect(identifiers.every((id) => id === 'custom-row' || id === 'agent-01')).toBe(true);
  });

  it('seed vs delete-all on an unmarked catalog does not recreate deleted rows', async () => {
    const [row] = await db
      .insert(platformAgentTemplates)
      .values({
        description: '',
        enabled: true,
        id: 'unmarked',
        identifier: 'custom-row',
        revision: 1,
        source: 'manual',
        systemRole: 'Keep me.',
        title: 'Custom',
      })
      .returning();
    await db.delete(platformTemplateCatalogState);

    await Promise.all([
      ensureAgentTemplateCatalogSeeded(db, { locale: 'en-US' }),
      new PlatformAgentTemplateModel(db).delete({
        expectedRevision: row!.revision,
        id: row!.id,
      }),
    ]);

    const remaining = await db.select().from(platformAgentTemplates);
    expect(remaining.map((item) => item.identifier)).not.toContain('agent-01');
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(1);
  });

  it('seed vs task-template import does not overwrite imported content', async () => {
    await Promise.all([
      ensureTaskTemplateCatalogSeeded(db, { locale: 'en-US' }),
      db.transaction(async (tx) => {
        await new PlatformTaskTemplateModel(tx).importByIdentifier({
          actorUserId: 'admin-zh',
          nextId: () => crypto.randomUUID(),
          rows: [taskRow('zh-CN')],
          seededLocale: 'zh-CN',
        });
      }),
    ]);

    const rows = await db.select().from(platformTaskTemplates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('工程日报');
  });
});

describe('ensureTaskTemplateCatalogSeeded', () => {
  it('imports the bundled library on a fresh catalog', async () => {
    await ensureTaskTemplateCatalogSeeded(db, { actorUserId: 'admin-1', locale: 'en-US' });

    const rows = await db.select().from(platformTaskTemplates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identifier).toBe('market-daily');
    expect(rows[0]?.id).toMatch(UUID_RE);
    expect(rows[0]?.source).toBe('market');
    expect(mocks.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.taskTemplates.importRecommendations',
        afterDiff: expect.objectContaining({ created: 1, reason: 'auto_seed' }),
      }),
    );
  });

  it('does not re-seed after every row is deleted', async () => {
    await ensureTaskTemplateCatalogSeeded(db);
    await db.delete(platformTaskTemplates);
    mocks.fetchTasks.mockClear();

    await ensureTaskTemplateCatalogSeeded(db);

    expect(await db.select().from(platformTaskTemplates)).toHaveLength(0);
    expect(mocks.fetchTasks).not.toHaveBeenCalled();
  });
});
