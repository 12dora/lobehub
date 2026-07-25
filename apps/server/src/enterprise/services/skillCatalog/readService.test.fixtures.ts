// @vitest-environment node
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload, platformSkillVersionChecksum } from '@/database/models/platform';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import {
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { SkillManifest } from '../../contracts/skillCatalog';
import { skillResourceContentChecksum } from '../../contracts/skillCatalog';
import {
  aiCatalogAuthorityToken,
  invalidateSkillCatalogAuthorityToken,
  skillCatalogAuthorityToken,
} from '../platformInstance/catalogTokens';
import { resetPublishedSkillCatalogReadCacheForTest } from './readService';

export const db: LobeChatDatabase = await getTestDB();

export const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
};

export const readServiceTestManifest = {
  description: 'Published Skill',
  displayName: 'Published Skill',
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

/** Alias kept for local brevity in split suites. */
export const manifest = readServiceTestManifest;

export const cleanupReadServiceTestDb = async () => {
  resetPublishedSkillCatalogReadCacheForTest();
  // Process-wide authority tokens must not leak across tests (same PGlite process).
  aiCatalogAuthorityToken.clear();
  skillCatalogAuthorityToken.clear();
  await db.execute(
    sql`TRUNCATE TABLE ${platformResourceRevisions}, ${platformSkillVersions}, ${platformSkills} CASCADE`,
  );
  // Reset persisted generation so peekAt(0) cold-starts after truncate-style fixtures.
  // Relation must exist via migration 0154 — do not swallow missing-relation errors.
  await db.execute(sql`
    UPDATE platform_catalog_authority
    SET generation = 0,
        token_kind = 'immutable_id',
        token_value = ${'0'.repeat(64)},
        updated_at = now()
  `);
};

export const installReadServiceTestLifecycle = () => {
  beforeEach(cleanupReadServiceTestDb);
  afterEach(async () => {
    await cleanupReadServiceTestDb();
  });
};

export const publishReadServiceSkill = async (params: {
  allowBuiltinOverride?: boolean;
  contentRef?: string | null;
  revision?: number;
  skillId?: string;
  skillKey: string;
  version: string;
}) => {
  const repository = new PlatformSkillCatalogRepository(db);
  const skill = params.skillId
    ? (await repository.getSkill(params.skillId))!
    : await repository.createSkill({
        allowBuiltinOverride: params.allowBuiltinOverride,
        enabled: false,
        name: 'Mutable draft name',
        skillKey: params.skillKey,
      });
  const content = `# ${params.version}`;
  const contentRef = params.contentRef === undefined ? 'opaque:skill-content-1' : params.contentRef;
  const resourceContent = 'reference';
  const resources = [
    {
      checksum: skillResourceContentChecksum(resourceContent),
      content: resourceContent,
      mediaType: 'text/plain',
      path: 'references/source.txt',
      sizeBytes: new TextEncoder().encode(resourceContent).byteLength,
    },
  ];
  const version = await repository.createVersion({
    checksum: platformSkillVersionChecksum({
      content,
      contentRef,
      manifest: readServiceTestManifest,
      resources,
    }),
    content,
    contentRef,
    manifest: readServiceTestManifest,
    resources,
    skillId: skill.id,
    version: params.version,
  });
  const revision = params.revision ?? 1;
  const payload = {
    skill: {
      allowBuiltinOverride: params.allowBuiltinOverride ?? false,
      description: 'Immutable published description',
      displayName: 'Immutable published name',
      distribution: 'default',
      enabled: true,
      skillKey: params.skillKey,
      source: 'uploaded',
    },
    versionId: version.id,
  } as const;
  await db.insert(platformResourceRevisions).values({
    checksum: checksumPayload(payload),
    payload,
    resourceId: skill.id,
    resourceType: 'skill',
    revision,
    status: 'published',
  });
  await repository.updateSkill(skill.id, {
    // Align pointer columns with the published snapshot (payload.enabled is always true).
    // Lightweight domain-target tokens read `platform_skills.enabled`, not the payload.
    currentVersionId: version.id,
    enabled: true,
    revision,
    status: 'published',
  });
  // Fixture publishes bypass PlatformPublisherService; advance authority like a real publish.
  const { PlatformCatalogAuthorityModel } = await import('@/database/models/platform');
  await new PlatformCatalogAuthorityModel(db).bumpGeneration('skill_catalog');
  invalidateSkillCatalogAuthorityToken();
  return { skill, version };
};
