// @vitest-environment node
/**
 * admin.taskTemplates — CRUD, enable/disable, CAS conflict mapping, import upsert,
 * and the user-facing platform read that decides market vs. platform authority.
 */
import { TASK_TEMPLATE_RECOMMEND_MAX_COUNT } from '@lobechat/const';
import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformTaskTemplates,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import type * as TaskTemplateModuleTypes from '@/server/services/taskTemplate';

import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { adminRouter } from '../admin';
import { platformRouter } from '../platform';
import { TASK_TEMPLATE_IMPORT_MAX_ROWS } from './taskTemplatesSupport';

type TaskTemplateModule = typeof TaskTemplateModuleTypes;

const db: LobeChatDatabase = await getTestDB();
const createAdminCaller = createCallerFactory(adminRouter);
const createPlatformCaller = createCallerFactory(platformRouter);

const ids = { admin: 'task-template-admin', viewer: 'task-template-viewer' };

const appendSpy = vi.hoisted(() => vi.fn());
const listDailyRecommendSpy = vi.hoisted(() => vi.fn());

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('../../services/platformAudit', () => ({
  PlatformAuditService: class {
    append = appendSpy;
  },
}));

vi.mock('@/server/services/taskTemplate', async (importOriginal) => {
  const actual = await importOriginal<TaskTemplateModule>();
  return {
    ...actual,
    TaskTemplateService: class {
      listDailyRecommendRaw = listDailyRecommendSpy;
    },
  };
});

const marketTemplate = (overrides: Record<string, unknown> = {}) => ({
  category: 'engineering',
  connectors: [],
  cronPattern: '0 9 * * *',
  description: 'Market description',
  id: 1,
  identifier: 'market-daily',
  instruction: 'Market instruction',
  interests: ['coding'],
  title: 'Market title',
  ...overrides,
});

const cleanup = async () => {
  await deletePlatformAuditLogsForTest(db, { actorUserIds: Object.values(ids) });
  await db.delete(platformTaskTemplates);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  appendSpy.mockReset();
  appendSpy.mockImplementation(async (params: { action: string }) => ({
    action: params.action,
    id: 'audit-ok',
    result: 'success',
  }));
  listDailyRecommendSpy.mockReset();
  await cleanup();
  await db.insert(users).values([{ id: ids.admin }, { id: ids.viewer }]);
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
    userId: ids.admin,
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const contextFor = async (userId: string) =>
  ({
    ...(await createContextInner({
      authenticatedAt: new Date(),
      authMethod: 'better-auth',
      userId,
    })),
    serverDB: db,
  }) as never;

const adminCaller = async (userId = ids.admin) =>
  createAdminCaller(await contextFor(userId)).taskTemplates;

const platformCaller = async (userId = ids.viewer) =>
  createPlatformCaller(await contextFor(userId)).taskTemplates;

const draft = (overrides: Record<string, unknown> = {}) => ({
  category: 'engineering' as const,
  connectors: [],
  cronPattern: '0 9 * * *',
  description: 'Daily engineering digest',
  enabled: true,
  icon: null,
  instruction: 'Summarize yesterday.',
  interests: ['coding' as const],
  title: 'Engineering digest',
  ...overrides,
});

describe('admin.taskTemplates authorization', () => {
  it('denies a principal without the platform-agent permissions', async () => {
    const caller = await adminCaller(ids.viewer);
    await expect(caller.list({ limit: 20, offset: 0 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses import for a create-only operator because it also overwrites existing rows', async () => {
    // A bespoke role holding AGENT_CREATE (+ read) but not AGENT_UPDATE.
    const [role] = await db
      .insert(roles)
      .values({ displayName: 'Task template creator', isSystem: false, name: 'tt-creator' })
      .returning();
    const grantable = await db
      .select()
      .from(permissions)
      .where(
        inArray(permissions.code, [
          PLATFORM_PERMISSIONS.ADMIN_ACCESS,
          PLATFORM_PERMISSIONS.AGENT_READ,
          PLATFORM_PERMISSIONS.AGENT_CREATE,
        ]),
      );
    await db
      .insert(rolePermissions)
      .values(grantable.map((row) => ({ permissionId: row.id, roleId: role!.id })));
    await db.insert(userRoles).values({ roleId: role!.id, userId: ids.viewer });

    const caller = await adminCaller(ids.viewer);
    // create is allowed…
    await expect(caller.create(draft())).resolves.toMatchObject({ source: 'manual' });
    // …but import, which rewrites existing content, is not.
    await expect(caller.importRecommendations({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('admin.taskTemplates validation', () => {
  it('rejects a cron that pins day-of-month or month', async () => {
    const caller = await adminCaller();
    await expect(caller.create(draft({ cronPattern: '0 9 1 * *' }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects an empty instruction', async () => {
    const caller = await adminCaller();
    await expect(caller.create(draft({ instruction: '   ' }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects a connector identifier no card could render', async () => {
    const caller = await adminCaller();
    await expect(
      caller.create(
        draft({
          connectors: [{ identifier: 'not-a-real-app', required: true, source: 'lobehub' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      caller.create(
        draft({ connectors: [{ identifier: 'github', required: true, source: 'lobehub' }] }),
      ),
    ).resolves.toMatchObject({ connectors: [{ identifier: 'github' }] });
  });

  it('reports a taken identifier as an input error, never an internal failure', async () => {
    const caller = await adminCaller();
    await caller.create(draft({ identifier: 'shared-slug' }));

    await expect(caller.create(draft({ identifier: 'shared-slug' }))).rejects.toMatchObject({
      cause: { data: { code: PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT } },
      code: 'BAD_REQUEST',
    });
  });
});

describe('admin.taskTemplates lifecycle', () => {
  it('creates with a derived identifier, audits, lists, and hard-deletes', async () => {
    const caller = await adminCaller();
    const created = await caller.create(draft());

    expect(created.identifier).toMatch(/^engineering-digest-[\da-z]{6}$/);
    expect(created.revision).toBe(1);
    expect(created.source).toBe('manual');
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.taskTemplates.create',
        targetType: 'task_template',
      }),
    );

    const listed = await caller.list({ limit: 20, offset: 0 });
    expect(listed.totalAll).toBe(1);
    expect(listed.totalFiltered).toBe(1);
    expect(listed.items[0]?.title).toBe('Engineering digest');

    await caller.delete({ expectedRevision: created.revision, id: created.id });
    expect(await db.select().from(platformTaskTemplates)).toHaveLength(0);
  });

  it('falls back to a custom-<suffix> identifier when the title has no latin characters', async () => {
    const caller = await adminCaller();
    const created = await caller.create(draft({ title: '工程日报' }));
    expect(created.identifier).toMatch(/^custom-[\da-z]{6}$/);
  });

  it('toggles enabled without touching the rest of the row', async () => {
    const caller = await adminCaller();
    const created = await caller.create(draft());

    const disabled = await caller.setEnabled({
      enabled: false,
      expectedRevision: created.revision,
      id: created.id,
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.title).toBe(created.title);
    expect(disabled.revision).toBe(created.revision + 1);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.taskTemplates.setEnabled' }),
    );
  });

  it('maps a stale expectedRevision to PLATFORM_REVISION_CONFLICT', async () => {
    const caller = await adminCaller();
    const created = await caller.create(draft());
    await caller.update({ ...draft({ title: 'First edit' }), expectedRevision: 1, id: created.id });

    await expect(
      caller.update({ ...draft({ title: 'Second edit' }), expectedRevision: 1, id: created.id }),
    ).rejects.toMatchObject({
      cause: { data: { code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT } },
      code: 'CONFLICT',
    });
  });

  it('refuses a stale toggle and a stale delete with PLATFORM_REVISION_CONFLICT', async () => {
    const caller = await adminCaller();
    const created = await caller.create(draft());
    // Another administrator edits the row; the open table still holds revision 1.
    await caller.update({
      ...draft({ title: 'Edited elsewhere' }),
      expectedRevision: 1,
      id: created.id,
    });

    await expect(
      caller.setEnabled({ enabled: false, expectedRevision: 1, id: created.id }),
    ).rejects.toMatchObject({
      cause: { data: { code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT } },
      code: 'CONFLICT',
    });
    await expect(caller.delete({ expectedRevision: 1, id: created.id })).rejects.toMatchObject({
      cause: { data: { code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT } },
      code: 'CONFLICT',
    });

    // Neither write landed.
    const [row] = await db.select().from(platformTaskTemplates);
    expect(row?.enabled).toBe(true);
    expect(row?.title).toBe('Edited elsewhere');
  });

  it('reports a missing row as NOT_FOUND rather than a conflict', async () => {
    const caller = await adminCaller();
    await expect(
      caller.setEnabled({ enabled: false, expectedRevision: 1, id: 'does-not-exist' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.delete({ expectedRevision: 1, id: 'does-not-exist' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('records bounded before/after audit summaries without free-text bodies', async () => {
    const caller = await adminCaller();
    const created = await caller.create(draft({ title: 'Audited' }));
    await caller.update({ ...draft({ title: 'Audited v2' }), expectedRevision: 1, id: created.id });

    const updateCall = appendSpy.mock.calls.find(
      ([params]) => params.action === 'admin.taskTemplates.update',
    );
    expect(updateCall?.[0].beforeDiff).toMatchObject({ revision: 1, title: 'Audited' });
    expect(updateCall?.[0].afterDiff).toMatchObject({ revision: 2, title: 'Audited v2' });
    // Bodies are represented by length, never content.
    expect(updateCall?.[0].afterDiff).not.toHaveProperty('instruction');
    expect(updateCall?.[0].afterDiff.instructionLength).toBe('Summarize yesterday.'.length);

    await caller.delete({ expectedRevision: 2, id: created.id });
    const deleteCall = appendSpy.mock.calls.find(
      ([params]) => params.action === 'admin.taskTemplates.delete',
    );
    // Deletion evidence belongs in beforeDiff — there is no "after".
    expect(deleteCall?.[0].beforeDiff).toMatchObject({ title: 'Audited v2' });
    expect(deleteCall?.[0].afterDiff).toBeUndefined();
  });

  it('rolls the row back when the audit append fails', async () => {
    const caller = await adminCaller();
    appendSpy.mockRejectedValueOnce(new Error('audit sink unavailable'));

    await expect(caller.create(draft())).rejects.toBeTruthy();
    expect(await db.select().from(platformTaskTemplates)).toHaveLength(0);
  });

  it('filters by enabled and search while still reporting the unfiltered total', async () => {
    const caller = await adminCaller();
    await caller.create(draft({ title: 'Alpha report' }));
    const beta = await caller.create(draft({ title: 'Beta report' }));
    await caller.setEnabled({ enabled: false, expectedRevision: beta.revision, id: beta.id });

    const enabledOnly = await caller.list({ enabled: true, limit: 20, offset: 0 });
    expect(enabledOnly.items.map((item) => item.title)).toEqual(['Alpha report']);
    expect(enabledOnly.totalFiltered).toBe(1);
    expect(enabledOnly.totalAll).toBe(2);

    const searched = await caller.list({ limit: 20, offset: 0, query: 'beta' });
    expect(searched.items.map((item) => item.title)).toEqual(['Beta report']);
  });
});

describe('admin.taskTemplates.importRecommendations', () => {
  it('imports market rows enabled and keeps the operator choices on re-import', async () => {
    const caller = await adminCaller();
    listDailyRecommendSpy.mockResolvedValue([marketTemplate()]);

    const first = await caller.importRecommendations({});
    expect(first).toEqual({ created: 1, skipped: 0, updated: 0 });

    const [imported] = await db.select().from(platformTaskTemplates);
    expect(imported?.enabled).toBe(true);
    expect(imported?.source).toBe('market');

    // Operator hides it and moves it to the back, then the market copy changes.
    await caller.setEnabled({
      enabled: false,
      expectedRevision: imported!.revision,
      id: imported!.id,
    });
    listDailyRecommendSpy.mockResolvedValue([marketTemplate({ title: 'Refreshed title' })]);

    const second = await caller.importRecommendations({});
    expect(second).toEqual({ created: 0, skipped: 0, updated: 1 });

    const rows = await db.select().from(platformTaskTemplates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Refreshed title');
    // enabled / sortOrder are the operator's, not the market's.
    expect(rows[0]?.enabled).toBe(false);
  });

  it('skips market rows that share an identifier instead of failing the whole import', async () => {
    const caller = await adminCaller();
    listDailyRecommendSpy.mockResolvedValue([marketTemplate(), marketTemplate({ id: 2 })]);

    expect(await caller.importRecommendations({})).toEqual({
      created: 1,
      skipped: 1,
      updated: 0,
    });
  });

  it('skips invalid market rows per row instead of failing the whole batch', async () => {
    const caller = await adminCaller();
    listDailyRecommendSpy.mockResolvedValue([
      marketTemplate({ identifier: 'good-row' }),
      // Every one of these must be rejected locally, not stored:
      marketTemplate({ cronPattern: '0 9 1 * *', identifier: 'bad-cron' }),
      marketTemplate({ identifier: 'Bad Identifier' }),
      marketTemplate({ identifier: 'oversized-title', title: 'x'.repeat(500) }),
      marketTemplate({ identifier: 'huge-instruction', instruction: 'x'.repeat(20_000) }),
      marketTemplate({
        connectors: [{ identifier: 'not-a-real-app', required: true, source: 'lobehub' }],
        identifier: 'unknown-connector',
      }),
      marketTemplate({ category: 'not-a-category', identifier: 'bad-category' }),
    ]);

    expect(await caller.importRecommendations({})).toEqual({
      created: 1,
      skipped: 6,
      updated: 0,
    });
    const rows = await db.select().from(platformTaskTemplates);
    expect(rows.map((row) => row.identifier)).toEqual(['good-row']);
  });

  it('surfaces an unavailable library instead of writing a partial catalog', async () => {
    const caller = await adminCaller();
    listDailyRecommendSpy.mockRejectedValue(new Error('market down'));

    await expect(caller.importRecommendations({})).rejects.toMatchObject({
      cause: {
        data: {
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          details: { reason: 'task_template_library_unavailable' },
        },
      },
    });
    expect(await db.select().from(platformTaskTemplates)).toHaveLength(0);
  });

  it('caps an oversized library batch and reports the excess as skipped', async () => {
    const caller = await adminCaller();
    // The batch must stay bounded even if the source hands back an unbounded array.
    listDailyRecommendSpy.mockResolvedValue(
      Array.from({ length: TASK_TEMPLATE_IMPORT_MAX_ROWS + 5 }, (_, index) =>
        marketTemplate({ id: index + 1, identifier: `market-row-${index}` }),
      ),
    );

    expect(await caller.importRecommendations({})).toEqual({
      created: TASK_TEMPLATE_IMPORT_MAX_ROWS,
      skipped: 5,
      updated: 0,
    });
    expect(await db.select().from(platformTaskTemplates)).toHaveLength(
      TASK_TEMPLATE_IMPORT_MAX_ROWS,
    );
  });

  it('audits what each imported identifier replaced, not just the counts', async () => {
    const caller = await adminCaller();
    listDailyRecommendSpy.mockResolvedValue([marketTemplate({ title: 'Original title' })]);
    await caller.importRecommendations({});

    appendSpy.mockClear();
    listDailyRecommendSpy.mockResolvedValue([marketTemplate({ title: 'Overwritten title' })]);
    await caller.importRecommendations({});

    const [params] = appendSpy.mock.calls.find(
      ([call]) => call.action === 'admin.taskTemplates.importRecommendations',
    )!;
    // The content the import discarded…
    expect(params.beforeDiff.rows).toEqual([
      expect.objectContaining({ identifier: 'market-daily', title: 'Original title' }),
    ]);
    // …and what it became.
    expect(params.afterDiff.rows).toEqual([
      expect.objectContaining({
        identifier: 'market-daily',
        inserted: false,
        title: 'Overwritten title',
      }),
    ]);
    expect(params.afterDiff).toMatchObject({ created: 0, skipped: 0, updated: 1 });
  });

  it('serializes concurrent imports of the same identifier onto one row', async () => {
    const caller = await adminCaller();
    listDailyRecommendSpy.mockResolvedValue([marketTemplate()]);
    appendSpy.mockClear();

    const results = await Promise.all([
      caller.importRecommendations({}),
      caller.importRecommendations({}),
    ]);

    const rows = await db.select().from(platformTaskTemplates);
    expect(rows).toHaveLength(1);
    // One import created the row, the other refreshed it — neither batch rolled back.
    expect(results.reduce((sum, result) => sum + result.created, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.updated, 0)).toBe(1);

    const importAudits = appendSpy.mock.calls
      .map(([params]) => params)
      .filter((params) => params.action === 'admin.taskTemplates.importRecommendations');
    expect(importAudits).toHaveLength(2);

    const createAudit = importAudits.find((params) => params.afterDiff.created === 1);
    const updateAudit = importAudits.find((params) => params.afterDiff.updated === 1);
    expect(createAudit?.afterDiff.rows).toEqual([
      expect.objectContaining({ identifier: 'market-daily', inserted: true }),
    ]);
    expect(createAudit?.beforeDiff.rows).toEqual([]);
    expect(updateAudit?.afterDiff.rows).toEqual([
      expect.objectContaining({ identifier: 'market-daily', inserted: false }),
    ]);
    expect(updateAudit?.beforeDiff.rows).toEqual([
      expect.objectContaining({ identifier: 'market-daily', title: 'Market title' }),
    ]);
  });
});

describe('admin.taskTemplates.reorder', () => {
  const createThree = async () => {
    const caller = await adminCaller();
    const first = await caller.create(draft({ title: 'First' }));
    const second = await caller.create(draft({ title: 'Second' }));
    const third = await caller.create(draft({ title: 'Third' }));
    return { caller, first, second, third };
  };

  it('appends new rows to the end rather than letting them jump the queue', async () => {
    const { caller } = await createThree();
    const listed = await caller.list({ limit: 20, offset: 0 });
    expect(listed.items.map((item) => item.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('moves a row and audits the resulting order', async () => {
    const { caller, first, second, third } = await createThree();
    appendSpy.mockClear();

    const result = await caller.reorder({
      items: [third, first, second].map((item) => ({
        expectedRevision: item.revision,
        id: item.id,
      })),
    });
    expect(result.items.map((item) => item.title)).toEqual(['Third', 'First', 'Second']);

    // The order is what the list actually serves afterwards.
    const listed = await caller.list({ limit: 20, offset: 0 });
    expect(listed.items.map((item) => item.title)).toEqual(['Third', 'First', 'Second']);
    // …and what the user-facing read serves.
    const platform = await (await platformCaller()).list();
    expect(platform.templates.map((item) => item.title)).toEqual(['Third', 'First', 'Second']);

    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.taskTemplates.reorder',
        afterDiff: expect.objectContaining({
          order: [third.identifier, first.identifier, second.identifier],
        }),
        targetType: 'task_template',
      }),
    );
  });

  it('reuses the slots the moved rows already occupied', async () => {
    const { caller, first, second, third } = await createThree();
    const before = await db.select().from(platformTaskTemplates);
    const slots = before.map((row) => row.sortOrder).sort((a, b) => a - b);

    await caller.reorder({
      items: [second, third, first].map((item) => ({
        expectedRevision: item.revision,
        id: item.id,
      })),
    });

    const after = await db.select().from(platformTaskTemplates);
    // No global renumbering: the same slot values are simply handed out in the new order.
    expect(after.map((row) => row.sortOrder).sort((a, b) => a - b)).toEqual(slots);
  });

  it('gives imported rows their own slots so they can be dragged afterwards', async () => {
    const caller = await adminCaller();
    listDailyRecommendSpy.mockResolvedValue([
      marketTemplate({ id: 1, identifier: 'market-a', title: 'A' }),
      marketTemplate({ id: 2, identifier: 'market-b', title: 'B' }),
      marketTemplate({ id: 3, identifier: 'market-c', title: 'C' }),
    ]);
    await caller.importRecommendations({});

    const rows = await db.select().from(platformTaskTemplates);
    // Sharing slot 0 would leave nothing for a later drag to reorder.
    expect(new Set(rows.map((row) => row.sortOrder)).size).toBe(3);

    const listed = await caller.list({ limit: 20, offset: 0 });
    const reversed = [...listed.items].reverse();
    const result = await caller.reorder({
      items: reversed.map((item) => ({ expectedRevision: item.revision, id: item.id })),
    });
    expect(result.items.map((item) => item.title)).toEqual(reversed.map((item) => item.title));
  });

  it('separates rows that share a legacy slot instead of collapsing the new order', async () => {
    const caller = await adminCaller();
    const { first, second, third } = await createThree();
    // Simulate rows written before drag ordering existed.
    await db.update(platformTaskTemplates).set({ sortOrder: 0 });

    const listed = await caller.list({ limit: 20, offset: 0 });
    await caller.reorder({
      items: [third, second, first].map((item) => ({
        expectedRevision: listed.items.find((row) => row.id === item.id)!.revision,
        id: item.id,
      })),
    });

    const rows = await db.select().from(platformTaskTemplates);
    expect(new Set(rows.map((row) => row.sortOrder)).size).toBe(3);
    expect((await caller.list({ limit: 20, offset: 0 })).items.map((item) => item.title)).toEqual([
      'Third',
      'Second',
      'First',
    ]);
  });

  it('rejects a drag performed against a stale table without applying any of it', async () => {
    const { caller, first, second, third } = await createThree();
    // Someone else edits `second` after the table was rendered.
    await caller.update({
      ...draft({ title: 'Edited elsewhere' }),
      expectedRevision: second.revision,
      id: second.id,
    });

    await expect(
      caller.reorder({
        items: [third, second, first].map((item) => ({
          expectedRevision: item.revision,
          id: item.id,
        })),
      }),
    ).rejects.toMatchObject({
      cause: { data: { code: PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT } },
      code: 'CONFLICT',
    });

    const listed = await caller.list({ limit: 20, offset: 0 });
    expect(listed.items.map((item) => item.title)).toEqual(['First', 'Edited elsewhere', 'Third']);
  });

  it('reports an unknown id as NOT_FOUND', async () => {
    const { caller, first } = await createThree();
    await expect(
      caller.reorder({
        items: [
          { expectedRevision: first.revision, id: first.id },
          { expectedRevision: 1, id: 'does-not-exist' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('needs the update permission, not just read', async () => {
    await createThree();
    await expect(
      (await adminCaller(ids.viewer)).reorder({ items: [{ expectedRevision: 1, id: 'x' }] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('retired connectors (a provider removed from the catalogs after the row was written)', () => {
  /** Writes straight to JSONB, bypassing the write-time contract, exactly as history would. */
  const seedRetiredConnectorRow = async (overrides: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(platformTaskTemplates)
      .values({
        category: 'engineering',
        connectors: [{ identifier: 'retired-provider', required: true, source: 'lobehub' }],
        cronPattern: '0 9 * * *',
        description: 'Written before the provider was retired',
        enabled: true,
        id: 'legacy-row',
        identifier: 'legacy-row',
        instruction: 'Still here.',
        interests: ['coding'],
        revision: 4,
        source: 'manual',
        title: 'Legacy template',
        ...overrides,
      })
      .returning();
    return row!;
  };

  it('keeps the admin list working so the operator can see and fix the row', async () => {
    await seedRetiredConnectorRow();
    const caller = await adminCaller();

    // One historical row must not fail output validation for the entire list.
    const listed = await caller.list({ limit: 20, offset: 0 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.connectors).toEqual([
      { identifier: 'retired-provider', required: true, source: 'lobehub' },
    ]);
  });

  it('quarantines the row from the public list instead of failing the managed catalog', async () => {
    await seedRetiredConnectorRow();
    const admin = await adminCaller();
    await admin.create(draft({ title: 'Healthy template' }));

    const result = await (await platformCaller()).list();
    // Still managed, still serving the rows that can actually render.
    expect(result.managed).toBe(true);
    expect(result.templates.map((template) => template.title)).toEqual(['Healthy template']);
  });

  it('refuses to save the row again until the retired connector is replaced', async () => {
    const row = await seedRetiredConnectorRow();
    const caller = await adminCaller();

    await expect(
      caller.update({
        ...draft({
          connectors: [{ identifier: 'retired-provider', required: true, source: 'lobehub' }],
        }),
        expectedRevision: row.revision,
        id: row.id,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Replacing it with a current provider saves fine.
    await expect(
      caller.update({
        ...draft({ connectors: [{ identifier: 'github', required: true, source: 'lobehub' }] }),
        expectedRevision: row.revision,
        id: row.id,
      }),
    ).resolves.toMatchObject({ connectors: [{ identifier: 'github' }] });
  });

  it('still allows the row to be toggled off or deleted without an edit', async () => {
    const row = await seedRetiredConnectorRow();
    const caller = await adminCaller();

    await expect(
      caller.setEnabled({ enabled: false, expectedRevision: row.revision, id: row.id }),
    ).resolves.toMatchObject({ enabled: false });
  });
});

describe('platform.taskTemplates.list', () => {
  it('stays unmanaged while the table is empty so the market keeps serving users', async () => {
    expect(await (await platformCaller()).list()).toEqual({ managed: false, templates: [] });
  });

  it('becomes authoritative once a row exists and serves only enabled rows', async () => {
    const admin = await adminCaller();
    const shown = await admin.create(draft({ title: 'Shown' }));
    const hidden = await admin.create(draft({ title: 'Hidden' }));
    await admin.setEnabled({ enabled: false, expectedRevision: hidden.revision, id: hidden.id });

    const result = await (await platformCaller()).list();
    expect(result.managed).toBe(true);
    expect(result.templates.map((item) => item.title)).toEqual(['Shown']);
    expect(result.templates[0]?.id).toBe(shown.id);
  });

  it('caps the per-user response at the recommendation maximum', async () => {
    const admin = await adminCaller();
    for (let index = 0; index < TASK_TEMPLATE_RECOMMEND_MAX_COUNT + 3; index += 1) {
      await admin.create(draft({ title: `Template ${index}` }));
    }

    const result = await (await platformCaller()).list();
    expect(result.templates).toHaveLength(TASK_TEMPLATE_RECOMMEND_MAX_COUNT);
    // Ordering survives the cap: sortOrder ascending.
    expect(result.templates[0]?.title).toBe('Template 0');
  });

  it('reports unmanaged when the platform-admin flag is off', async () => {
    await (await adminCaller()).create(draft());
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '');

    expect(await (await platformCaller()).list()).toEqual({ managed: false, templates: [] });
  });
});
