// @vitest-environment node
/**
 * admin.agentTemplates — CRUD, enable/disable, CAS conflict mapping, import upsert,
 * and the user-facing platform read that always reports a managed catalog when the module is on.
 */
import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import { PlatformAgentTemplateModel } from '@/database/models/platform';
import {
  permissions,
  platformAgentTemplates,
  platformTemplateCatalogState,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { AGENT_TEMPLATE_DISPLAY_MAX } from '../../contracts/adminAgentTemplates';
import { ensureAgentTemplateCatalogSeeded } from '../../services/templateCatalogBootstrap';
import { holdCatalogTxAndAssertBlocked } from '../../testing/catalogLockBarrier';
import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { adminRouter } from '../admin';
import { platformRouter } from '../platform';
import { deriveAgentTemplateIdentifier } from './agentTemplatesSupport';

const db: LobeChatDatabase = await getTestDB();
const createAdminCaller = createCallerFactory(adminRouter);
const createPlatformCaller = createCallerFactory(platformRouter);

const ids = { admin: 'agent-template-admin', viewer: 'agent-template-viewer' };

const appendSpy = vi.hoisted(() => vi.fn());
const builtInSpy = vi.hoisted(() => vi.fn());

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('../../services/platformAudit', () => ({
  PlatformAuditService: class {
    append = appendSpy;
  },
}));

vi.mock('./builtInAgentTemplates', () => ({
  builtInAgentTemplatesForImport: (locale?: string) => builtInSpy(locale),
}));

const builtinRow = (overrides: Record<string, unknown> = {}) => ({
  description: '',
  identifier: 'agent-01',
  systemRole: 'You are a writer.',
  title: 'Writer',
  ...overrides,
});

const cleanup = async () => {
  await deletePlatformAuditLogsForTest(db, { actorUserIds: Object.values(ids) });
  await db.delete(platformAgentTemplates);
  await db.delete(platformTemplateCatalogState);
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
  builtInSpy.mockReset();
  builtInSpy.mockImplementation(() => [builtinRow()]);
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
  createAdminCaller(await contextFor(userId)).agentTemplates;

const platformCaller = async (userId = ids.viewer) =>
  createPlatformCaller(await contextFor(userId)).agentTemplates;

const draft = (overrides: Record<string, unknown> = {}) => ({
  avatar: null,
  backgroundColor: null,
  description: 'A short subtitle',
  enabled: true,
  systemRole: 'You are a helpful writing mentor.',
  tags: ['writing'],
  title: 'Writing mentor',
  ...overrides,
});

describe('deriveAgentTemplateIdentifier', () => {
  it('slugifies a latin title and falls back when the title has no latin characters', () => {
    expect(deriveAgentTemplateIdentifier('Writing Mentor', 'abc123')).toBe('writing-mentor-abc123');
    expect(deriveAgentTemplateIdentifier('工程日报', 'abc123')).toBe('custom-abc123');
  });
});

describe('admin.agentTemplates authorization', () => {
  it('denies a principal without the platform-agent permissions', async () => {
    const caller = await adminCaller(ids.viewer);
    await expect(caller.list({ limit: 20, offset: 0 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses import for a create-only operator because it also overwrites existing rows', async () => {
    const [role] = await db
      .insert(roles)
      .values({ displayName: 'Agent template creator', isSystem: false, name: 'at-creator' })
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
    await expect(caller.create(draft())).resolves.toMatchObject({ source: 'manual' });
    await expect(caller.importBuiltins({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('admin.agentTemplates validation', () => {
  it('rejects an empty system role', async () => {
    const caller = await adminCaller();
    await expect(caller.create(draft({ systemRole: '   ' }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects an empty title', async () => {
    const caller = await adminCaller();
    await expect(caller.create(draft({ title: '' }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
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

describe('admin.agentTemplates lifecycle', () => {
  it('creates with a derived identifier, audits, lists, and hard-deletes', async () => {
    const caller = await adminCaller();
    const created = await caller.create(draft());

    expect(created.identifier).toMatch(/^writing-mentor-[\da-z]{6}$/);
    expect(created.revision).toBe(1);
    expect(created.source).toBe('manual');
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.agentTemplates.create',
        targetType: 'agent_template',
      }),
    );

    const listed = await caller.list({ limit: 20, offset: 0 });
    expect(listed.origin).toBe('managed');
    expect(listed.totalAll).toBe(1);
    expect(listed.totalFiltered).toBe(1);
    expect(listed.items[0]?.title).toBe('Writing mentor');

    await caller.delete({ expectedRevision: created.revision, id: created.id });
    expect(await db.select().from(platformAgentTemplates)).toHaveLength(0);
  });

  it('falls back to a custom-<suffix> identifier when the title has no latin characters', async () => {
    const caller = await adminCaller();
    const created = await caller.create(draft({ title: '写作导师' }));
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
      expect.objectContaining({ action: 'admin.agentTemplates.setEnabled' }),
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

    const [row] = await db.select().from(platformAgentTemplates);
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
      ([params]) => params.action === 'admin.agentTemplates.update',
    );
    expect(updateCall?.[0].beforeDiff).toMatchObject({ revision: 1, title: 'Audited' });
    expect(updateCall?.[0].afterDiff).toMatchObject({ revision: 2, title: 'Audited v2' });
    expect(updateCall?.[0].afterDiff).not.toHaveProperty('systemRole');
    expect(updateCall?.[0].afterDiff.systemRoleLength).toBe(
      'You are a helpful writing mentor.'.length,
    );

    await caller.delete({ expectedRevision: 2, id: created.id });
    const deleteCall = appendSpy.mock.calls.find(
      ([params]) => params.action === 'admin.agentTemplates.delete',
    );
    expect(deleteCall?.[0].beforeDiff).toMatchObject({ title: 'Audited v2' });
    expect(deleteCall?.[0].afterDiff).toBeUndefined();
  });

  it('rolls the row back when the audit append fails', async () => {
    const caller = await adminCaller();
    appendSpy.mockRejectedValueOnce(new Error('audit sink unavailable'));

    await expect(caller.create(draft())).rejects.toBeTruthy();
    expect(await db.select().from(platformAgentTemplates)).toHaveLength(0);
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

describe('admin.agentTemplates.importBuiltins', () => {
  it('imports built-in rows enabled and keeps the operator choices on re-import', async () => {
    const caller = await adminCaller();

    const first = await caller.importBuiltins({});
    expect(first).toEqual({ created: 1, skipped: 0, updated: 0 });

    const [imported] = await db.select().from(platformAgentTemplates);
    expect(imported?.enabled).toBe(true);
    expect(imported?.source).toBe('builtin');
    expect(imported?.identifier).toBe('agent-01');

    await caller.setEnabled({
      enabled: false,
      expectedRevision: imported!.revision,
      id: imported!.id,
    });
    builtInSpy.mockImplementation(() => [builtinRow({ title: 'Refreshed title' })]);

    const second = await caller.importBuiltins({});
    expect(second).toEqual({ created: 0, skipped: 0, updated: 1 });

    const rows = await db.select().from(platformAgentTemplates);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Refreshed title');
    expect(rows[0]?.enabled).toBe(false);
  });

  it('skips duplicate identifiers instead of failing the whole import', async () => {
    const caller = await adminCaller();
    builtInSpy.mockImplementation(() => [
      builtinRow(),
      builtinRow({ systemRole: 'Duplicate prompt' }),
    ]);

    expect(await caller.importBuiltins({})).toEqual({
      created: 1,
      skipped: 1,
      updated: 0,
    });
  });

  it('skips invalid built-in rows per row instead of failing the whole batch', async () => {
    const caller = await adminCaller();
    // The real loader always emits 40 slots (empty title/prompt stay on the row). The mock
    // must do the same — otherwise missing locale keys would be dropped before `skipped`.
    builtInSpy.mockImplementation(() =>
      Array.from({ length: 40 }, (_, index) => {
        const nn = String(index + 1).padStart(2, '0');
        if (index === 0) return builtinRow({ identifier: `agent-${nn}` });
        if (index === 1) return builtinRow({ identifier: `agent-${nn}`, title: '' });
        if (index === 2) return builtinRow({ identifier: `agent-${nn}`, systemRole: '' });
        if (index === 3) return builtinRow({ identifier: `agent-${nn}`, title: 'x'.repeat(500) });
        return builtinRow({ identifier: `agent-${nn}`, title: '', systemRole: '' });
      }),
    );

    expect(await caller.importBuiltins({})).toEqual({
      created: 1,
      skipped: 39,
      updated: 0,
    });
    const rows = await db.select().from(platformAgentTemplates);
    expect(rows.map((row) => row.identifier)).toEqual(['agent-01']);
  });

  it('forwards the console locale to the built-in loader', async () => {
    const caller = await adminCaller();
    builtInSpy.mockImplementation((locale?: string) => [
      builtinRow({ title: locale === 'zh-CN' ? '写作导师' : 'Writer' }),
    ]);

    await caller.importBuiltins({ locale: 'zh-CN' });
    expect(builtInSpy).toHaveBeenCalledWith('zh-CN');
    const [row] = await db.select().from(platformAgentTemplates);
    expect(row?.title).toBe('写作导师');
  });

  it('audits what each imported identifier replaced, not just the counts', async () => {
    const caller = await adminCaller();
    builtInSpy.mockImplementation(() => [builtinRow({ title: 'Original title' })]);
    await caller.importBuiltins({});

    appendSpy.mockClear();
    builtInSpy.mockImplementation(() => [builtinRow({ title: 'Overwritten title' })]);
    await caller.importBuiltins({});

    const [params] = appendSpy.mock.calls.find(
      ([call]) => call.action === 'admin.agentTemplates.importBuiltins',
    )!;
    expect(params.beforeDiff.rows).toEqual([
      expect.objectContaining({ identifier: 'agent-01', title: 'Original title' }),
    ]);
    expect(params.afterDiff.rows).toEqual([
      expect.objectContaining({
        identifier: 'agent-01',
        inserted: false,
        title: 'Overwritten title',
      }),
    ]);
    expect(params.afterDiff).toMatchObject({ created: 0, skipped: 0, updated: 1 });
  });

  it('serializes concurrent imports of the same identifier onto one row', async () => {
    const caller = await adminCaller();
    appendSpy.mockClear();

    const results = await Promise.all([caller.importBuiltins({}), caller.importBuiltins({})]);

    const rows = await db.select().from(platformAgentTemplates);
    expect(rows).toHaveLength(1);
    expect(results.reduce((sum, result) => sum + result.created, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.updated, 0)).toBe(1);

    const importAudits = appendSpy.mock.calls
      .map(([params]) => params)
      .filter((params) => params.action === 'admin.agentTemplates.importBuiltins');
    expect(importAudits).toHaveLength(2);

    const createAudit = importAudits.find((params) => params.afterDiff.created === 1);
    const updateAudit = importAudits.find((params) => params.afterDiff.updated === 1);
    expect(createAudit?.afterDiff.rows).toEqual([
      expect.objectContaining({ identifier: 'agent-01', inserted: true }),
    ]);
    expect(createAudit?.beforeDiff.rows).toEqual([]);
    expect(updateAudit?.afterDiff.rows).toEqual([
      expect.objectContaining({ identifier: 'agent-01', inserted: false }),
    ]);
    expect(updateAudit?.beforeDiff.rows).toEqual([
      expect.objectContaining({ identifier: 'agent-01', title: 'Writer' }),
    ]);
  });
});

describe('admin.agentTemplates.reorder', () => {
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

    const listed = await caller.list({ limit: 20, offset: 0 });
    expect(listed.items.map((item) => item.title)).toEqual(['Third', 'First', 'Second']);
    const platform = await (await platformCaller()).list();
    expect(platform.templates.map((item) => item.title)).toEqual(['Third', 'First', 'Second']);

    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.agentTemplates.reorder',
        afterDiff: expect.objectContaining({
          order: [third.identifier, first.identifier, second.identifier],
        }),
        targetType: 'agent_template',
      }),
    );
  });

  it('reuses the slots the moved rows already occupied', async () => {
    const { caller, first, second, third } = await createThree();
    const before = await db.select().from(platformAgentTemplates);
    const slots = before.map((row) => row.sortOrder).sort((a, b) => a - b);

    await caller.reorder({
      items: [second, third, first].map((item) => ({
        expectedRevision: item.revision,
        id: item.id,
      })),
    });

    const after = await db.select().from(platformAgentTemplates);
    expect(after.map((row) => row.sortOrder).sort((a, b) => a - b)).toEqual(slots);
  });

  it('gives imported rows their own slots so they can be dragged afterwards', async () => {
    const caller = await adminCaller();
    builtInSpy.mockImplementation(() => [
      builtinRow({ identifier: 'agent-01', title: 'A' }),
      builtinRow({ identifier: 'agent-02', title: 'B' }),
      builtinRow({ identifier: 'agent-03', title: 'C' }),
    ]);
    await caller.importBuiltins({});

    const rows = await db.select().from(platformAgentTemplates);
    expect(new Set(rows.map((row) => row.sortOrder)).size).toBe(3);

    const listed = await caller.list({ limit: 20, offset: 0 });
    const reversed = [...listed.items].reverse();
    const result = await caller.reorder({
      items: reversed.map((item) => ({ expectedRevision: item.revision, id: item.id })),
    });
    expect(result.items.map((item) => item.title)).toEqual(reversed.map((item) => item.title));
  });

  it('rejects a drag performed against a stale table without applying any of it', async () => {
    const { caller, first, second, third } = await createThree();
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

describe('admin.agentTemplates list auto-seed', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('seeds built-in rows on a fresh catalog with managed origin and UUID ids', async () => {
    const listed = await (await adminCaller()).list({ limit: 100, offset: 0 });

    expect(listed.origin).toBe('managed');
    expect(listed.totalAll).toBe(1);
    expect(listed.totalFiltered).toBe(1);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.id).toMatch(UUID_RE);
    expect(listed.items[0]).toMatchObject({
      enabled: true,
      identifier: 'agent-01',
      source: 'builtin',
      title: 'Writer',
    });
    expect(listed.items[0]?.id.startsWith('preview:')).toBe(false);
    expect(await db.select().from(platformAgentTemplates)).toHaveLength(1);
    expect(await (await platformCaller()).list()).toMatchObject({
      managed: true,
      templates: [expect.objectContaining({ identifier: 'agent-01' })],
    });
  });

  it('does not duplicate rows when two lists race the first seed', async () => {
    const caller = await adminCaller();
    const [a, b] = await Promise.all([
      caller.list({ limit: 100, offset: 0 }),
      caller.list({ limit: 100, offset: 0 }),
    ]);

    expect(a.origin).toBe('managed');
    expect(b.origin).toBe('managed');
    expect(await db.select().from(platformAgentTemplates)).toHaveLength(1);
    expect(new Set([...a.items, ...b.items].map((item) => item.id)).size).toBe(1);
  });

  it('stays managed and empty after every row is deleted and does not re-seed', async () => {
    const caller = await adminCaller();
    const seeded = await caller.list({ limit: 100, offset: 0 });
    await caller.delete({
      expectedRevision: seeded.items[0]!.revision,
      id: seeded.items[0]!.id,
    });

    const listed = await caller.list({ limit: 100, offset: 0 });
    expect(listed).toEqual({ items: [], origin: 'managed', totalAll: 0, totalFiltered: 0 });
    expect(await db.select().from(platformAgentTemplates)).toHaveLength(0);
    expect(await (await platformCaller()).list()).toEqual({ managed: true, templates: [] });
  });

  it('writes a marker only when rows already exist and never overwrites them', async () => {
    const caller = await adminCaller();
    await caller.create(draft({ title: 'Custom' }));

    const listed = await caller.list({ limit: 20, offset: 0 });
    expect(listed.origin).toBe('managed');
    expect(listed.totalAll).toBe(1);
    expect(listed.items.map((item) => item.title)).toEqual(['Custom']);
    expect(await db.select().from(platformTemplateCatalogState)).toEqual([
      expect.objectContaining({ domain: 'agent_templates' }),
    ]);
  });

  it('seeds in the console locale passed by the list input', async () => {
    builtInSpy.mockImplementation((locale?: string) => [
      builtinRow({ title: locale === 'zh-CN' ? '写作导师' : 'Writer' }),
    ]);

    const listed = await (await adminCaller()).list({ limit: 20, locale: 'zh-CN', offset: 0 });
    expect(listed.origin).toBe('managed');
    expect(listed.items[0]?.title).toBe('写作导师');
  });
});

describe('unrenderable rows (empty title / system role written before validation)', () => {
  const seedBlankRow = async () => {
    const [row] = await db
      .insert(platformAgentTemplates)
      .values({
        description: '',
        enabled: true,
        id: 'legacy-row',
        identifier: 'legacy-row',
        revision: 4,
        source: 'manual',
        systemRole: '   ',
        title: 'Legacy template',
      })
      .returning();
    return row!;
  };

  it('keeps the admin list working so the operator can see and fix the row', async () => {
    await seedBlankRow();
    const caller = await adminCaller();
    const listed = await caller.list({ limit: 20, offset: 0 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.title).toBe('Legacy template');
  });

  it('quarantines the row from the public list instead of failing the managed catalog', async () => {
    await seedBlankRow();
    const admin = await adminCaller();
    await admin.create(draft({ title: 'Healthy template' }));

    const result = await (await platformCaller()).list();
    expect(result.managed).toBe(true);
    expect(result.templates.map((template) => template.title)).toEqual(['Healthy template']);
  });
});

describe('platform.agentTemplates.list', () => {
  it('auto-seeds on first list and reports a managed catalog', async () => {
    const result = await (await platformCaller()).list();
    expect(result.managed).toBe(true);
    expect(result.templates).toEqual([expect.objectContaining({ identifier: 'agent-01' })]);
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

  it('caps the per-user response at the display maximum', async () => {
    await db.insert(platformAgentTemplates).values(
      Array.from({ length: AGENT_TEMPLATE_DISPLAY_MAX + 3 }, (_, index) => ({
        description: '',
        enabled: true,
        id: `cap-${index}`,
        identifier: `cap-${index}`,
        revision: 1,
        sortOrder: index,
        source: 'manual' as const,
        systemRole: `Role ${index}`,
        title: `Template ${index}`,
      })),
    );

    const result = await (await platformCaller()).list();
    expect(result.templates).toHaveLength(AGENT_TEMPLATE_DISPLAY_MAX);
    expect(result.templates[0]?.title).toBe('Template 0');
  });

  it('reports unmanaged when the platform-admin flag is off', async () => {
    await (await adminCaller()).create(draft());
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '');

    expect(await (await platformCaller()).list()).toEqual({ managed: false, templates: [] });
  });

  it('does not seed when the platform-admin flag is off', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '');

    expect(await (await platformCaller()).list()).toEqual({ managed: false, templates: [] });
    expect(await db.select().from(platformAgentTemplates)).toHaveLength(0);
    expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(0);
  });
});

const isServerDB = process.env.TEST_SERVER_DB === '1';

describe.skipIf(!isServerDB)(
  'admin.agentTemplates catalog lock races (TEST_SERVER_DB=1)',
  { timeout: 20_000 },
  () => {
    it('create holds the catalog lock: list/seed waits and inserts nothing', async () => {
      const caller = await adminCaller();
      await holdCatalogTxAndAssertBlocked({
        domain: 'agent_templates',
        competing: () => caller.list({ limit: 20, locale: 'en-US', offset: 0 }),
        work: async (tx) => {
          await new PlatformAgentTemplateModel(tx).create({
            actorUserId: ids.admin,
            document: {
              avatar: null,
              backgroundColor: null,
              description: 'A short subtitle',
              enabled: true,
              systemRole: 'You are a helpful writing mentor.',
              tags: ['writing'],
              title: 'Custom',
            },
            id: crypto.randomUUID(),
            identifier: 'custom-row',
            source: 'manual',
          });
        },
      });

      expect((await db.select().from(platformAgentTemplates)).map((row) => row.identifier)).toEqual(
        ['custom-row'],
      );
    });

    it('seed holds the catalog lock: create waits, then appends beside builtins', async () => {
      builtInSpy.mockImplementation(() => [builtinRow()]);
      const caller = await adminCaller();
      await holdCatalogTxAndAssertBlocked({
        domain: 'agent_templates',
        competing: () => caller.create(draft({ identifier: 'custom-row', title: 'Custom' })),
        work: async (tx) => {
          await ensureAgentTemplateCatalogSeeded(tx as unknown as LobeChatDatabase, {
            locale: 'en-US',
          });
        },
      });

      expect(
        (await db.select().from(platformAgentTemplates)).map((row) => row.identifier).sort(),
      ).toEqual(['agent-01', 'custom-row']);
    });

    it('import holds the catalog lock: list/seed waits and does not overwrite zh-CN', async () => {
      builtInSpy.mockImplementation((locale?: string) => [
        builtinRow({ title: locale === 'zh-CN' ? '写作导师' : 'Writer' }),
      ]);
      const caller = await adminCaller();
      await holdCatalogTxAndAssertBlocked({
        domain: 'agent_templates',
        competing: () => caller.list({ limit: 20, locale: 'en-US', offset: 0 }),
        work: async (tx) => {
          await new PlatformAgentTemplateModel(tx).importByIdentifier({
            actorUserId: ids.admin,
            nextId: () => crypto.randomUUID(),
            rows: [
              {
                description: '',
                identifier: 'agent-01',
                systemRole: 'You are a writer.',
                title: '写作导师',
              },
            ],
            seededLocale: 'zh-CN',
          });
        },
      });

      const rows = await db.select().from(platformAgentTemplates);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe('写作导师');
    });

    it('delete-all holds the catalog lock: list/seed waits and does not recreate builtins', async () => {
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
      const caller = await adminCaller();

      await holdCatalogTxAndAssertBlocked({
        domain: 'agent_templates',
        competing: () => caller.list({ limit: 100, offset: 0 }),
        work: async (tx) => {
          await new PlatformAgentTemplateModel(tx).delete({
            expectedRevision: row!.revision,
            id: row!.id,
          });
        },
      });

      expect(
        (await db.select().from(platformAgentTemplates)).map((item) => item.identifier),
      ).not.toContain('agent-01');
      expect(await db.select().from(platformTemplateCatalogState)).toHaveLength(1);
    });
  },
);
