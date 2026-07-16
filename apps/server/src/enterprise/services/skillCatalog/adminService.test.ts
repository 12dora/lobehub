// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformSkillVersionChecksum } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { SkillManifest } from '../../contracts/skillCatalog';
import { SkillCatalogAdminService } from './adminService';
import { SkillCatalogValidationError } from './errors';
import { SkillCatalogReadService } from './readService';

const db: LobeChatDatabase = await getTestDB();
const invalidation = { publish: vi.fn(async () => {}) };
const serviceOptions = { builtinSkillKeys: new Set<string>(), invalidation };

const manifest = {
  description: 'Search approved sources',
  displayName: 'Approved search',
  localizedDescriptions: {},
  localizedDisplayNames: {},
  permissions: {
    filesystem: 'none',
    network: { allowedHosts: [], enabled: false },
    tools: { allow: [] },
  },
  skillDependencies: [],
  toolDependencies: [],
} satisfies SkillManifest;

const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformSkillVersions},
      ${platformSkills}
    CASCADE
  `);
};

beforeEach(async () => {
  await cleanup();
  invalidation.publish.mockClear();
});
afterEach(cleanup);

const createDraft = async (service: SkillCatalogAdminService, skillKey = 'approved.search') =>
  service.create('admin-1', {
    allowBuiltinOverride: false,
    displayName: 'Approved search',
    distribution: 'default',
    enabled: true,
    reason: 'create reviewed skill',
    skillKey,
  });

const createVersion = async (
  service: SkillCatalogAdminService,
  draft: Awaited<ReturnType<typeof createDraft>>,
  content: string,
  version: string,
  selectedManifest: SkillManifest = manifest,
) => {
  const resources = [
    {
      checksum: 'a'.repeat(64),
      content: 'reference',
      mediaType: 'text/plain',
      path: 'references/source.txt',
      sizeBytes: 9,
    },
  ];
  const payload = {
    content,
    contentRef: 'opaque:skill-content-1',
    manifest: selectedManifest,
    resources,
  };
  return service.createVersion('admin-1', {
    ...payload,
    checksum: platformSkillVersionChecksum(payload),
    expectedDraftToken: draft.draftToken,
    expectedRevision: draft.draft.revision,
    reason: 'create reviewed immutable version',
    skillId: draft.draft.id,
    version,
  });
};

describe('SkillCatalogAdminService', () => {
  it('creates, validates and publishes an exact server-only runtime projection', async () => {
    const service = new SkillCatalogAdminService(db, serviceOptions);
    const draft = await createDraft(service);
    const version = await createVersion(service, draft, '# approved v1', '1.0.0');
    const afterVersion = await service.getDetail(draft.draft.id);
    const validation = await service.validate('admin-1', {
      expectedDraftToken: afterVersion.draftToken,
      expectedRevision: afterVersion.baseRevision,
      reason: 'validate reviewed version',
      skillId: draft.draft.id,
      versionId: version.id,
    });
    expect(validation.issues).toEqual([]);

    const published = await service.publish('admin-1', {
      expectedDraftToken: afterVersion.draftToken,
      expectedRevision: afterVersion.baseRevision,
      id: draft.draft.id,
      reason: 'publish reviewed version',
      versionId: version.id,
    });
    expect(published).toMatchObject({ status: 'published', versionId: version.id });

    const reader = new SkillCatalogReadService(db);
    const catalog = await reader.getPublishedCatalog();
    expect(catalog.skills).toEqual([
      expect.objectContaining({ skillKey: 'approved.search', version: '1.0.0' }),
    ]);
    expect(JSON.stringify(catalog)).not.toContain('# approved v1');
    expect(JSON.stringify(catalog)).not.toContain('opaque:skill-content-1');
    await expect(reader.resolveForExecution('approved.search', '1.0.0')).resolves.toMatchObject({
      checksum: version.checksum,
      content: '# approved v1',
      contentRef: 'opaque:skill-content-1',
      resources: [expect.objectContaining({ path: 'references/source.txt' })],
      versionId: version.id,
    });
    expect(invalidation.publish).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['skill-catalog', 'skill-runtime'] }),
    );
  });

  it('keeps runtime on the immutable snapshot after mutable draft edits', async () => {
    const service = new SkillCatalogAdminService(db, serviceOptions);
    const draft = await createDraft(service, 'stable.runtime');
    const version = await createVersion(service, draft, '# stable', '1.0.0');
    const ready = await service.getDetail(draft.draft.id);
    await service.publish('admin-1', {
      expectedDraftToken: ready.draftToken,
      expectedRevision: ready.baseRevision,
      id: draft.draft.id,
      reason: 'publish stable snapshot',
      versionId: version.id,
    });
    const publishedDetail = await service.getDetail(draft.draft.id);
    await service.updateDraft('admin-1', {
      displayName: 'Unpublished rename',
      distribution: 'mandatory',
      enabled: false,
      expectedDraftToken: publishedDetail.draftToken,
      expectedRevision: publishedDetail.baseRevision,
      id: draft.draft.id,
      reason: 'edit next draft only',
    });

    await expect(
      new SkillCatalogReadService(db).resolveForExecution('stable.runtime'),
    ).resolves.toMatchObject({
      displayName: 'Approved search',
      distribution: 'default',
      versionId: version.id,
    });
  });

  it('revalidates under the publication lock and refuses unpublished dependencies', async () => {
    const service = new SkillCatalogAdminService(db, serviceOptions);
    const draft = await createDraft(service, 'blocked.dependency');
    const invalidManifest: SkillManifest = {
      ...manifest,
      skillDependencies: [{ optional: false, skillKey: 'missing.skill', version: '1.0.0' }],
    };
    const version = await createVersion(service, draft, '# blocked', '1.0.0', invalidManifest);
    const ready = await service.getDetail(draft.draft.id);
    await expect(
      service.publish('admin-1', {
        expectedDraftToken: ready.draftToken,
        expectedRevision: ready.baseRevision,
        id: draft.draft.id,
        reason: 'must not publish missing dependency',
        versionId: version.id,
      }),
    ).rejects.toBeInstanceOf(SkillCatalogValidationError);
    expect(
      await new SkillCatalogReadService(db).resolveForExecution('blocked.dependency'),
    ).toBeUndefined();
  });

  it('rolls back and archives through immutable published revisions', async () => {
    const service = new SkillCatalogAdminService(db, serviceOptions);
    const draft = await createDraft(service, 'rollback.skill');
    const first = await createVersion(service, draft, '# first', '1.0.0');
    let detail = await service.getDetail(draft.draft.id);
    await service.publish('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'publish first',
      versionId: first.id,
    });
    detail = await service.getDetail(draft.draft.id);
    const second = await createVersion(
      service,
      { draft: detail.draft, draftToken: detail.draftToken },
      '# second',
      '2.0.0',
    );
    detail = await service.getDetail(draft.draft.id);
    await service.publish('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'publish second',
      versionId: second.id,
    });
    detail = await service.getDetail(draft.draft.id);
    await service.rollback('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'rollback to reviewed first',
      targetVersionId: first.id,
    });
    await expect(
      new SkillCatalogReadService(db).resolveForExecution('rollback.skill'),
    ).resolves.toMatchObject({
      content: '# first',
      versionId: first.id,
    });
    detail = await service.getDetail(draft.draft.id);
    await service.archive('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'archive reviewed skill',
    });
    expect(
      await new SkillCatalogReadService(db).resolveForExecution('rollback.skill'),
    ).toBeUndefined();
    await expect(
      new SkillCatalogReadService(db).resolveForExecution('rollback.skill', '1.0.0'),
    ).resolves.toMatchObject({ content: '# first' });
  });

  it('records mutation reasons and rejects stale draft tokens', async () => {
    const service = new SkillCatalogAdminService(db, serviceOptions);
    const draft = await createDraft(service, 'audited.skill');
    await service.updateDraft('admin-1', {
      displayName: 'Updated once',
      expectedDraftToken: draft.draftToken,
      expectedRevision: draft.draft.revision,
      id: draft.draft.id,
      reason: 'first audited update',
    });
    await expect(
      service.updateDraft('admin-1', {
        displayName: 'Stale update',
        expectedDraftToken: draft.draftToken,
        expectedRevision: draft.draft.revision,
        id: draft.draft.id,
        reason: 'stale audited update',
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_REVISION_CONFLICT' });
    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'first audited update', result: 'success' }),
        expect.objectContaining({ reason: 'stale audited update', result: 'failure' }),
      ]),
    );
  });

  it('fails closed when the builtin catalog was not supplied', async () => {
    const service = new SkillCatalogAdminService(db, { invalidation });
    const draft = await createDraft(service, 'catalog.unavailable');
    const version = await createVersion(service, draft, '# unavailable', '1.0.0');
    expect(version.validation?.issues).toContainEqual(
      expect.objectContaining({ code: 'builtin_override_forbidden' }),
    );
    const detail = await service.getDetail(draft.draft.id);
    await expect(
      service.publish('admin-1', {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: draft.draft.id,
        reason: 'must fail closed without builtin catalog',
        versionId: version.id,
      }),
    ).rejects.toBeInstanceOf(SkillCatalogValidationError);
  });

  it('rolls back create, update and createVersion when success audit insertion fails', async () => {
    const beforeSuccessAudit = vi.fn(async () => {
      throw new Error('injected audit failure');
    });
    const failing = new SkillCatalogAdminService(db, {
      ...serviceOptions,
      lifecycle: { beforeSuccessAudit },
    });
    await expect(createDraft(failing, 'atomic.create')).rejects.toThrow('injected audit failure');
    expect((await failing.list({ limit: 100 })).items).toEqual([]);

    const normal = new SkillCatalogAdminService(db, serviceOptions);
    const draft = await createDraft(normal, 'atomic.existing');
    await expect(
      failing.updateDraft('admin-1', {
        displayName: 'Must roll back',
        expectedDraftToken: draft.draftToken,
        expectedRevision: draft.draft.revision,
        id: draft.draft.id,
        reason: 'inject update audit failure',
      }),
    ).rejects.toThrow('injected audit failure');
    expect((await normal.getDetail(draft.draft.id)).draft.displayName).toBe('Approved search');

    await expect(createVersion(failing, draft, '# must roll back', '1.0.0')).rejects.toThrow(
      'injected audit failure',
    );
    const afterVersionFailure = await normal.getDetail(draft.draft.id);
    expect(afterVersionFailure.latestVersion).toBeNull();
    expect(afterVersionFailure.draft.draftSequence).toBe(draft.draft.draftSequence);
    expect(beforeSuccessAudit).toHaveBeenCalledTimes(3);
  });
});
