// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import { platformSkillVersionChecksum } from '@/database/models/platform';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
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
import { resolvePlatformSkillRuntimeSnapshot } from './runtimeSnapshot';

const db: LobeChatDatabase = await getTestDB();
const invalidation = { publish: vi.fn(async () => {}) };
const serviceOptions = { builtinSkillKeys: new Set<string>(), invalidation };

/**
 * Bridge until the migration-owned batch teaches `prevent_platform_skill_version_mutation`
 * to honor `lobe.allow_platform_skill_version_validation_update` for validation_result-only
 * UPDATEs (mirrors 0140 agent-version delete / 0145 audit retention GUCs). Production code
 * only sets the GUC — it must not disable triggers via session_replication_role.
 */
const installSkillVersionValidationUpdateGuard = async () => {
  await db.execute(
    sql.raw(`
CREATE OR REPLACE FUNCTION prevent_platform_skill_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('lobe.allow_platform_skill_version_validation_update', true) = 'on'
  THEN
    IF NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.skill_id IS NOT DISTINCT FROM OLD.skill_id
       AND NEW.version IS NOT DISTINCT FROM OLD.version
       AND NEW.content IS NOT DISTINCT FROM OLD.content
       AND NEW.content_ref IS NOT DISTINCT FROM OLD.content_ref
       AND NEW.checksum IS NOT DISTINCT FROM OLD.checksum
       AND NEW.manifest IS NOT DISTINCT FROM OLD.manifest
       AND NEW.resources IS NOT DISTINCT FROM OLD.resources
       AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
       AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'platform_skill_versions are immutable' USING ERRCODE = '55000';
END;
$$;
`),
  );
};

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

beforeAll(async () => {
  await installSkillVersionValidationUpdateGuard();
});

beforeEach(async () => {
  await cleanup();
  invalidation.publish.mockClear();
  vi.restoreAllMocks();
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
  options: { contentRef?: string | null } = {},
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
    contentRef: options.contentRef === undefined ? null : options.contentRef,
    manifest: selectedManifest,
    resources,
  };
  const result = await service.createVersion('admin-1', {
    ...payload,
    expectedDraftToken: draft.draftToken,
    expectedRevision: draft.draft.revision,
    reason: 'create reviewed immutable version',
    skillId: draft.draft.id,
    version,
  });
  expect(result.checksum).toBe(platformSkillVersionChecksum(payload));
  return result;
};

describe('SkillCatalogAdminService', () => {
  it('creates, validates and publishes an inline execution-ready runtime projection', async () => {
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
    expect(reader.isPublishedCatalogExecutionReady(catalog)).toBe(true);
    await expect(reader.resolveForExecution('approved.search', '1.0.0')).resolves.toMatchObject({
      checksum: version.checksum,
      content: '# approved v1',
      contentRef: null,
      resources: [expect.objectContaining({ path: 'references/source.txt' })],
      versionId: version.id,
    });
    // End-to-end: a successfully published inline catalog is immediately accepted by the
    // managed runtime snapshot resolver (not only by the readiness helper).
    const runtime = await resolvePlatformSkillRuntimeSnapshot({
      db,
      effectiveMode: 'enforced',
      flags: { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_SKILLS: true },
      identity: { agentId: 'agent-1', operationId: 'op-1', userId: 'admin-1' },
      options: {
        catalogService: reader,
        signProof: vi.fn().mockResolvedValue('signed-proof'),
      },
    });
    expect(runtime?.catalog.refs).toEqual([
      expect.objectContaining({ skillKey: 'approved.search', version: '1.0.0' }),
    ]);
    expect(runtime?.skills.some((skill) => skill.identifier === 'approved.search')).toBe(true);
    expect(invalidation.publish).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['skill-catalog', 'skill-runtime'] }),
    );
  });

  it('rejects publication of opaque contentRef that runtime cannot execute', async () => {
    const service = new SkillCatalogAdminService(db, serviceOptions);
    const draft = await createDraft(service, 'opaque.blocked');
    const version = await createVersion(service, draft, '# opaque body', '1.0.0', manifest, {
      contentRef: 'opaque:skill-content-1',
    });
    const ready = await service.getDetail(draft.draft.id);
    const validation = await service.validate('admin-1', {
      expectedDraftToken: ready.draftToken,
      expectedRevision: ready.baseRevision,
      reason: 'validate opaque version',
      skillId: draft.draft.id,
      versionId: version.id,
    });
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ code: 'non_inline_content', severity: 'error' }),
    );
    await expect(
      service.publish('admin-1', {
        expectedDraftToken: ready.draftToken,
        expectedRevision: ready.baseRevision,
        id: draft.draft.id,
        reason: 'must not publish opaque content',
        versionId: version.id,
      }),
    ).rejects.toBeInstanceOf(SkillCatalogValidationError);
    expect(
      await new SkillCatalogReadService(db).resolveForExecution('opaque.blocked'),
    ).toBeUndefined();
  });

  it('rejects publication of empty-string contentRef (corrupted legacy non-null)', async () => {
    // Admin createVersion coerces falsy contentRef to null; insert a legacy empty-string row
    // directly so validate/publish still fail closed (aligned with readService readiness).
    const service = new SkillCatalogAdminService(db, serviceOptions);
    const draft = await createDraft(service, 'empty.ref.blocked');
    const content = '# empty ref body';
    const contentRef = '';
    const resources = [
      {
        checksum: 'a'.repeat(64),
        content: 'reference',
        mediaType: 'text/plain',
        path: 'references/source.txt',
        sizeBytes: 9,
      },
    ];
    const version = await new PlatformSkillCatalogRepository(db).createVersion({
      checksum: platformSkillVersionChecksum({ content, contentRef, manifest, resources }),
      content,
      contentRef,
      manifest,
      resources,
      skillId: draft.draft.id,
      version: '1.0.0',
    });
    // Confirm the corrupted empty string survived storage (not coerced to null).
    expect(version.contentRef).toBe('');
    const ready = await service.getDetail(draft.draft.id);
    const validation = await service.validate('admin-1', {
      expectedDraftToken: ready.draftToken,
      expectedRevision: ready.baseRevision,
      reason: 'validate empty-string contentRef',
      skillId: draft.draft.id,
      versionId: version.id,
    });
    expect(validation.issues).toContainEqual(
      expect.objectContaining({ code: 'non_inline_content', severity: 'error' }),
    );
    await expect(
      service.publish('admin-1', {
        expectedDraftToken: ready.draftToken,
        expectedRevision: ready.baseRevision,
        id: draft.draft.id,
        reason: 'must not publish empty contentRef',
        versionId: version.id,
      }),
    ).rejects.toBeInstanceOf(SkillCatalogValidationError);
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
    expect(
      (await service.listVersions({ skillId: draft.draft.id })).items.find(
        (item) => item.id === first.id,
      )?.lastPublishedRevision,
    ).toBeNull();
    let detail = await service.getDetail(draft.draft.id);
    await service.publish('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'publish first',
      versionId: first.id,
    });
    expect(
      (await service.listVersions({ skillId: draft.draft.id })).items.find(
        (item) => item.id === first.id,
      )?.lastPublishedRevision,
    ).toBe(1);
    detail = await service.getDetail(draft.draft.id);
    const second = await createVersion(
      service,
      { draft: detail.draft, draftToken: detail.draftToken },
      '# second',
      '2.0.0',
    );
    expect(
      (await service.listVersions({ skillId: draft.draft.id })).items.find(
        (item) => item.id === second.id,
      )?.lastPublishedRevision,
    ).toBeNull();
    detail = await service.getDetail(draft.draft.id);
    await service.publish('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'publish second',
      versionId: second.id,
    });
    expect(
      (await service.listVersions({ skillId: draft.draft.id })).items.find(
        (item) => item.id === second.id,
      )?.lastPublishedRevision,
    ).toBe(2);
    detail = await service.getDetail(draft.draft.id);
    await service.rollback('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'rollback to reviewed first',
      targetVersionId: first.id,
    });
    const versionsAfterRollback = await service.listVersions({ skillId: draft.draft.id });
    expect(
      versionsAfterRollback.items.find((item) => item.id === first.id)?.lastPublishedRevision,
    ).toBe(3);
    expect(
      versionsAfterRollback.items.find((item) => item.id === second.id)?.lastPublishedRevision,
    ).toBe(2);
    const detailAfterRollback = await service.getDetail(draft.draft.id);
    expect(detailAfterRollback.latestVersion).toMatchObject({
      id: second.id,
      lastPublishedRevision: 2,
    });
    expect(detailAfterRollback.publishedVersion).toMatchObject({
      id: first.id,
      lastPublishedRevision: 3,
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

  it('keeps an archived builtin override suppressed until rollback restores it', async () => {
    const skillKey = 'builtin.search';
    const builtinContent = '# builtin';
    const builtin = {
      checksum: platformSkillVersionChecksum({ content: builtinContent, manifest }),
      content: builtinContent,
      description: 'Builtin search',
      displayName: 'Builtin search',
      distribution: 'default' as const,
      manifest,
      skillKey,
      source: 'builtin' as const,
      version: '1.0.0',
    };
    const service = new SkillCatalogAdminService(db, {
      allowBuiltinOverride: true,
      builtinSkills: [builtin],
      invalidation,
    });
    const draft = await service.create('admin-1', {
      allowBuiltinOverride: true,
      displayName: 'Managed search',
      distribution: 'default',
      enabled: true,
      reason: 'create approved builtin override',
      skillKey,
    });
    const version = await createVersion(service, draft, '# managed', '2.0.0');
    let detail = await service.getDetail(draft.draft.id);
    await service.publish('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'publish approved builtin override',
      versionId: version.id,
    });

    let reader = new SkillCatalogReadService(db, { builtinSkills: [builtin] });
    await expect(reader.resolveForExecution(skillKey)).resolves.toMatchObject({
      source: 'uploaded',
      version: '2.0.0',
    });

    detail = await service.getDetail(draft.draft.id);
    await service.archive('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'archive approved builtin override',
    });
    reader = new SkillCatalogReadService(db, { builtinSkills: [builtin] });
    await expect(reader.resolveForExecution(skillKey)).resolves.toBeUndefined();
    await expect(reader.getPublishedCatalog()).resolves.toMatchObject({ skills: [] });
    const archived = await db.query.platformResourceRevisions.findFirst({
      orderBy: (revision, { desc }) => [desc(revision.revision)],
      where: (revision, { eq }) => eq(revision.resourceId, draft.draft.id),
    });
    expect(archived).toMatchObject({
      payload: { builtinOverrideTombstone: true },
      status: 'archived',
    });

    detail = await service.getDetail(draft.draft.id);
    await service.rollback('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'restore approved builtin override',
      targetVersionId: version.id,
    });
    reader = new SkillCatalogReadService(db, { builtinSkills: [builtin] });
    await expect(reader.resolveForExecution(skillKey)).resolves.toMatchObject({
      source: 'uploaded',
      version: '2.0.0',
    });
  });

  it('rejects secret-bearing versions before any version row or draft-sequence change', async () => {
    const service = new SkillCatalogAdminService(db, serviceOptions);
    const draft = await createDraft(service, 'secret.blocked');
    const before = await service.getDetail(draft.draft.id);
    await expect(
      service.createVersion('admin-1', {
        content: 'postgres://admin:password@db.internal/catalog',
        contentRef: null,
        expectedDraftToken: before.draftToken,
        expectedRevision: before.baseRevision,
        manifest,
        reason: 'must not persist secret material',
        resources: [],
        skillId: draft.draft.id,
        version: '1.0.0',
      }),
    ).rejects.toBeInstanceOf(SkillCatalogValidationError);
    const after = await service.getDetail(draft.draft.id);
    expect(after.draft.draftSequence).toBe(before.draft.draftSequence);
    expect(after.latestVersion).toBeNull();
    const versions = await db.query.platformSkillVersions.findMany({
      where: (row, { eq: equals }) => equals(row.skillId, draft.draft.id),
    });
    expect(versions).toHaveLength(0);
  });

  it('persists a refreshed validation result so getVersion matches validate', async () => {
    const service = new SkillCatalogAdminService(db, serviceOptions);
    const draft = await createDraft(service, 'validate.refresh');
    const version = await createVersion(service, draft, '# validate refresh', '1.0.0');
    const oldValidatedAt = version.validation?.validatedAt;
    expect(oldValidatedAt).toBeInstanceOf(Date);
    const before = await service.getDetail(draft.draft.id);
    // Ensure the re-validation timestamp is strictly after create-time metadata.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const validation = await service.validate('admin-1', {
      expectedDraftToken: before.draftToken,
      expectedRevision: before.baseRevision,
      reason: 'refresh validation metadata',
      skillId: draft.draft.id,
      versionId: version.id,
    });
    const stored = await service.getVersion(draft.draft.id, version.id);
    expect(stored.validation).toEqual(validation);
    expect(stored.validation?.validatedAt).toBeInstanceOf(Date);
    // Fresh timestamp must advance past the create-time validation stamp;
    // equality of the full result is the contract the admin UI verifies.
    expect(stored.validation!.validatedAt.getTime()).toBeGreaterThan(oldValidatedAt!.getTime());
    expect(JSON.stringify(stored.validation)).toBe(JSON.stringify(validation));
    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'admin.skills.validate',
          reason: 'refresh validation metadata',
          result: 'success',
          targetId: draft.draft.id,
        }),
      ]),
    );
  });

  it('rolls back validation metadata when PlatformAuditService.append fails', async () => {
    const normal = new SkillCatalogAdminService(db, serviceOptions);
    const draft = await createDraft(normal, 'validate.atomic');
    const version = await createVersion(normal, draft, '# validate atomic', '1.0.0');
    const oldValidatedAt = version.validation?.validatedAt;
    expect(oldValidatedAt).toBeInstanceOf(Date);
    const before = await normal.getDetail(draft.draft.id);

    // Fault-inject the real append path (instance field) via constructor — not a lifecycle hook —
    // so this proves validation persistence and the success audit share one transaction.
    const platformAudit = await import('../platformAudit');
    const appendMock = vi.fn().mockRejectedValue(new Error('injected validate audit failure'));
    vi.spyOn(platformAudit, 'PlatformAuditService').mockImplementation(
      () =>
        ({
          append: appendMock,
        }) as never,
    );

    await expect(
      normal.validate('admin-1', {
        expectedDraftToken: before.draftToken,
        expectedRevision: before.baseRevision,
        reason: 'inject validate audit failure',
        skillId: draft.draft.id,
        versionId: version.id,
      }),
    ).rejects.toThrow('injected validate audit failure');

    // Validation write must roll back with the failed audit; timestamp stays at create-time.
    const stored = await normal.getVersion(draft.draft.id, version.id);
    expect(stored.validation?.validatedAt?.getTime()).toBe(oldValidatedAt!.getTime());
    expect(JSON.stringify(stored.validation)).toBe(JSON.stringify(version.validation));
    const audits = await db.select().from(platformAuditLogs);
    expect(
      audits.filter((row) => row.action === 'admin.skills.validate' && row.result === 'success'),
    ).toHaveLength(0);
    expect(appendMock).toHaveBeenCalled();
    expect(appendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'admin.skills.validate',
        result: 'success',
        targetId: draft.draft.id,
      }),
    );
  });

  it('archives never-published empty shells and versioned drafts without a current pointer', async () => {
    const service = new SkillCatalogAdminService(db, serviceOptions);
    const empty = await createDraft(service, 'never.published.empty');
    const emptyArchived = await service.archive('admin-1', {
      expectedDraftToken: empty.draftToken,
      expectedRevision: empty.draft.revision,
      id: empty.draft.id,
      reason: 'archive accidental empty draft',
    });
    expect(emptyArchived).toMatchObject({
      revision: 0,
      skillId: empty.draft.id,
      status: 'archived',
      versionId: null,
    });
    const emptyDetail = await service.getDetail(empty.draft.id);
    expect(emptyDetail.draft.status).toBe('archived');
    expect(emptyDetail.draft.revision).toBe(0);
    // Pointerless positive revisions break authority; revision-zero archived must not.
    await expect(new SkillCatalogReadService(db).getPublishedCatalog()).resolves.toMatchObject({
      skills: [],
    });
    // Terminal: identity/version mutations must not revive the shell.
    await expect(
      service.updateDraft('admin-1', {
        displayName: 'should not apply',
        expectedDraftToken: emptyDetail.draftToken,
        expectedRevision: emptyDetail.baseRevision,
        id: empty.draft.id,
        reason: 'mutate archived shell',
      }),
    ).rejects.toThrow(/not found/i);

    const versioned = await createDraft(service, 'never.published.versioned');
    await createVersion(service, versioned, '# never published', '1.0.0');
    const ready = await service.getDetail(versioned.draft.id);
    expect(ready.draft.currentVersionId).toBeNull();
    const versionedArchived = await service.archive('admin-1', {
      expectedDraftToken: ready.draftToken,
      expectedRevision: ready.baseRevision,
      id: versioned.draft.id,
      reason: 'archive versioned unpublished draft',
    });
    expect(versionedArchived).toMatchObject({
      revision: 0,
      status: 'archived',
      versionId: null,
    });
    const versionedDetail = await service.getDetail(versioned.draft.id);
    expect(versionedDetail.draft.status).toBe('archived');
    expect(versionedDetail.draft.revision).toBe(0);
    expect(versionedDetail.latestVersion?.version).toBe('1.0.0');
    await expect(new SkillCatalogReadService(db).getPublishedCatalog()).resolves.toMatchObject({
      skills: [],
    });
    await expect(
      service.createVersion('admin-1', {
        content: '# after archive',
        contentRef: null,
        expectedDraftToken: versionedDetail.draftToken,
        expectedRevision: versionedDetail.baseRevision,
        manifest,
        reason: 'mutate archived versioned shell',
        resources: [],
        skillId: versioned.draft.id,
        version: '1.0.1',
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('keeps builtin override suppressed when archiving a disabled draft', async () => {
    const skillKey = 'builtin.disabled.archive';
    const builtinContent = '# builtin disabled archive';
    const builtin = {
      checksum: platformSkillVersionChecksum({ content: builtinContent, manifest }),
      content: builtinContent,
      description: 'Builtin disabled archive',
      displayName: 'Builtin disabled archive',
      distribution: 'default' as const,
      manifest,
      skillKey,
      source: 'builtin' as const,
      version: '1.0.0',
    };
    const service = new SkillCatalogAdminService(db, {
      allowBuiltinOverride: true,
      builtinSkills: [builtin],
      invalidation,
    });
    const draft = await service.create('admin-1', {
      allowBuiltinOverride: true,
      displayName: 'Managed disabled archive',
      distribution: 'default',
      enabled: true,
      reason: 'create override',
      skillKey,
    });
    const version = await createVersion(service, draft, '# managed disabled', '2.0.0');
    let detail = await service.getDetail(draft.draft.id);
    await service.publish('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'publish override',
      versionId: version.id,
    });
    detail = await service.getDetail(draft.draft.id);
    // Unpublished identity draft disables the override, then archive.
    await service.updateDraft('admin-1', {
      enabled: false,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'disable before archive',
    });
    detail = await service.getDetail(draft.draft.id);
    expect(detail.draft.enabled).toBe(false);
    await service.archive('admin-1', {
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.baseRevision,
      id: draft.draft.id,
      reason: 'archive disabled override',
    });
    const reader = new SkillCatalogReadService(db, { builtinSkills: [builtin] });
    // Tombstone must remain eligible so the bundled skill stays suppressed.
    await expect(reader.resolveForExecution(skillKey)).resolves.toBeUndefined();
    await expect(reader.getPublishedCatalog()).resolves.toMatchObject({ skills: [] });
    const archived = await db.query.platformResourceRevisions.findFirst({
      orderBy: (revision, { desc }) => [desc(revision.revision)],
      where: (revision, { eq }) => eq(revision.resourceId, draft.draft.id),
    });
    expect(archived).toMatchObject({
      payload: {
        builtinOverrideTombstone: true,
        skill: expect.objectContaining({ enabled: true }),
      },
      status: 'archived',
    });
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
