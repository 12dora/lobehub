// @vitest-environment node
import { ssrfSafeFetch } from '@lobechat/ssrf-safe-fetch';
import { inArray, sql } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformSkills,
  platformSkillVersions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import { ADMIN_MUTATION_REGISTRY } from '../../security/policy/adminMutationRegistry';
import { ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY } from '../../security/policy/adminProcedureAuthorizationRegistry';
import { adminRouter } from '../admin';
import { MAX_IMPORT_ZIP_BYTES } from './skillsImportParse';

const db: LobeChatDatabase = await getTestDB();
const createRootCaller = createCallerFactory(adminRouter);
const createCaller = (context: Parameters<typeof createRootCaller>[0]) =>
  createRootCaller(context).skills;

const ids = {
  creator: 'parse-import-creator',
  reader: 'parse-import-reader',
  superAdmin: 'parse-import-super',
};

const SKILL_MD = `---
name: Demo Skill
description: A demo skill
---

# Demo Skill

Demo skill body content.
`;

vi.mock('@lobechat/ssrf-safe-fetch', () => ({ ssrfSafeFetch: vi.fn() }));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformSkillVersions},
      ${platformSkills},
      ${userRoles},
      ${rolePermissions},
      ${roles},
      ${permissions},
      ${users}
    CASCADE
  `);
};

const grantPermissions = async (userId: string, name: string, codes: string[]) => {
  const [role] = await db
    .insert(roles)
    .values({ displayName: name, name, workspaceId: null })
    .returning();
  const rows = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, codes));
  await db
    .insert(rolePermissions)
    .values(rows.map(({ id }) => ({ permissionId: id, roleId: role.id })));
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '1');
  vi.mocked(ssrfSafeFetch).mockReset();
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
    userId: ids.superAdmin,
  });
  await grantPermissions(ids.creator, 'parse_import_creator', [PLATFORM_PERMISSIONS.SKILL_CREATE]);
  await grantPermissions(ids.reader, 'parse_import_reader', [PLATFORM_PERMISSIONS.SKILL_READ]);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (params: { userId?: string }) =>
  createCaller({
    ...(await createContextInner({
      authenticatedAt: new Date(),
      authMethod: 'better-auth',
      userId: params.userId,
    })),
    serverDB: db,
  } as never);

describe('admin.skills.parseImportSource', () => {
  it('parses a markdown skill from a URL without persisting anything', async () => {
    vi.mocked(ssrfSafeFetch).mockResolvedValue(
      new Response(SKILL_MD, { headers: { 'content-type': 'text/markdown' } }),
    );
    const caller = await callerFor({ userId: ids.creator });
    const result = await caller.parseImportSource({
      source: 'url',
      url: 'https://example.com/skills/demo/SKILL.md',
    });

    expect(result.displayName).toBe('Demo Skill');
    expect(result.description).toBe('A demo skill');
    expect(result.content).toContain('# Demo Skill');
    expect(result.resources).toEqual([]);
    expect(result.suggestedSkillKey).toBe('url.example.com.skills.demo.skill');
    expect(result.suggestedSkillKey).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    expect(result.sourceMeta).toEqual({
      kind: 'url',
      origin: 'https://example.com/skills/demo/SKILL.md',
    });
    expect(vi.mocked(ssrfSafeFetch)).toHaveBeenCalledWith(
      'https://example.com/skills/demo/SKILL.md',
      expect.objectContaining({ signal: expect.anything() }),
    );

    // Parse-only: no skills / versions persisted.
    expect(await db.select().from(platformSkills)).toEqual([]);
    expect(await db.select().from(platformSkillVersions)).toEqual([]);
  });

  it('parses a base64 ZIP package including text resources', async () => {
    const zipped = zipSync({
      'SKILL.md': strToU8(SKILL_MD),
      'references/notes.md': strToU8('# notes'),
    });
    const caller = await callerFor({ userId: ids.superAdmin });
    const result = await caller.parseImportSource({
      fileName: 'demo-skill.zip',
      source: 'zip',
      zipBase64: Buffer.from(zipped).toString('base64'),
    });

    expect(result.displayName).toBe('Demo Skill');
    expect(result.suggestedSkillKey).toBe('demo-skill');
    expect(result.resourcesTruncated).toBeUndefined();
    expect(result.resources).toEqual([
      expect.objectContaining({
        content: '# notes',
        mediaType: 'text/markdown',
        path: 'references/notes.md',
        sizeBytes: 7,
      }),
    ]);
    expect(result.resources[0]!.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceMeta).toEqual({ kind: 'zip', origin: 'demo-skill.zip' });
    expect(await db.select().from(platformSkills)).toEqual([]);
  });

  it('rejects a ZIP whose decoded size exceeds 20MB with BAD_REQUEST', async () => {
    const caller = await callerFor({ userId: ids.superAdmin });
    await expect(
      caller.parseImportSource({
        fileName: 'too-big.zip',
        source: 'zip',
        zipBase64: Buffer.alloc(MAX_IMPORT_ZIP_BYTES + 1).toString('base64'),
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/20MB/),
    });
  });

  it('rejects an unparsable ZIP with BAD_REQUEST instead of INTERNAL_SERVER_ERROR', async () => {
    const caller = await callerFor({ userId: ids.superAdmin });
    await expect(
      caller.parseImportSource({
        fileName: 'not-a-zip.zip',
        source: 'zip',
        zipBase64: Buffer.from('plain text, not a zip').toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('requires SKILL_CREATE and rejects anonymous callers', async () => {
    const anonymous = await callerFor({});
    await expect(
      anonymous.parseImportSource({ source: 'url', url: 'https://example.com/SKILL.md' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const reader = await callerFor({ userId: ids.reader });
    await expect(
      reader.parseImportSource({ source: 'url', url: 'https://example.com/SKILL.md' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(vi.mocked(ssrfSafeFetch)).not.toHaveBeenCalled();
  });

  it('fails closed when the managed-skills feature flag is off', async () => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_SKILLS', '0');
    const caller = await callerFor({ userId: ids.superAdmin });
    try {
      await caller.parseImportSource({ source: 'url', url: 'https://example.com/SKILL.md' });
      expect.fail('expected feature disabled');
    } catch (error) {
      expect(getEnterpriseErrorBody(error)?.code).toBe('PLATFORM_FEATURE_DISABLED');
    }
    expect(vi.mocked(ssrfSafeFetch)).not.toHaveBeenCalled();
  });

  it('is registered in both admin policy registries', () => {
    expect(ADMIN_MUTATION_REGISTRY['admin.skills.parseImportSource']).toMatchObject({
      dangerous: false,
      risk: 'low',
    });
    expect(ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY).toContainEqual({
      kind: 'mutation',
      path: 'admin.skills.parseImportSource',
      permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_CREATE] },
    });
  });
});
