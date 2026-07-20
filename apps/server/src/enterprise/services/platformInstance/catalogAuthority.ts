import { isRecord } from '@lobechat/utils/object';
import { and, asc, eq, gt } from 'drizzle-orm';

import {
  checksumPayload,
  parsePlatformPublishedSkillSnapshot,
  platformSkillVersionChecksum,
} from '@/database/models/platform';
import type { PlatformPublishedSkillView } from '@/database/models/platform/skillCatalog';
import type { PlatformResourceRevisionItem } from '@/database/schemas/platform';
import {
  platformAiProviders,
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { AiCatalogTokenEntry, SkillCatalogTokenEntry } from './catalogTokens';
import { buildAiCatalogRevisionToken, PlatformCatalogTokenInvariantError } from './catalogTokens';

type CatalogDatabase = LobeChatDatabase | Transaction;

const isChecksum = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export interface CurrentAiCatalogSnapshot {
  revisions: PlatformResourceRevisionItem[];
  token: ReturnType<typeof buildAiCatalogRevisionToken>;
}

/**
 * The only process-runtime authority for the active AI catalog. History rows are never scanned:
 * every published provider pointer must resolve its exact immutable revision or the whole catalog
 * fails closed.
 */
export const loadCurrentAiCatalogSnapshot = async (
  db: CatalogDatabase,
): Promise<CurrentAiCatalogSnapshot> => {
  const rows = await db
    .select({
      pointerRevision: platformAiProviders.revision,
      providerId: platformAiProviders.id,
      providerKey: platformAiProviders.providerKey,
      revision: platformResourceRevisions,
    })
    .from(platformAiProviders)
    .leftJoin(
      platformResourceRevisions,
      and(
        eq(platformResourceRevisions.resourceType, 'provider'),
        eq(platformResourceRevisions.resourceId, platformAiProviders.id),
        eq(platformResourceRevisions.revision, platformAiProviders.revision),
      ),
    )
    .where(gt(platformAiProviders.revision, 0))
    .orderBy(asc(platformAiProviders.providerKey), asc(platformAiProviders.id));

  const revisions: PlatformResourceRevisionItem[] = [];
  const tokenEntries: AiCatalogTokenEntry[] = [];
  for (const row of rows) {
    const revision = row.revision;
    if (!revision) throw new PlatformCatalogTokenInvariantError();
    if (
      row.pointerRevision <= 0 ||
      revision.resourceType !== 'provider' ||
      revision.resourceId !== row.providerId ||
      revision.revision !== row.pointerRevision ||
      (revision.status !== 'published' && revision.status !== 'archived') ||
      !isChecksum(revision.checksum) ||
      checksumPayload(revision.payload) !== revision.checksum
    ) {
      throw new PlatformCatalogTokenInvariantError();
    }
    if (revision.status === 'archived') continue;
    if (
      !isRecord(revision.payload.provider) ||
      revision.payload.provider.providerKey !== row.providerKey ||
      typeof revision.payload.provider.enabled !== 'boolean' ||
      typeof revision.payload.provider.displayName !== 'string' ||
      !Array.isArray(revision.payload.models) ||
      revision.payload.models.some(
        (model) =>
          !isRecord(model) ||
          typeof model.enabled !== 'boolean' ||
          typeof model.modelKey !== 'string' ||
          typeof model.type !== 'string',
      )
    ) {
      throw new PlatformCatalogTokenInvariantError();
    }
    revisions.push(revision);
    tokenEntries.push({
      checksum: revision.checksum,
      providerId: row.providerId,
      providerKey: row.providerKey,
      revision: row.pointerRevision,
      secretFingerprint: revision.secretFingerprint ?? null,
    });
  }
  return { revisions, token: buildAiCatalogRevisionToken(tokenEntries) };
};

export interface CurrentSkillCatalogSnapshot {
  builtinOverrideTombstones: string[];
  items: PlatformPublishedSkillView[];
  tokenEntries: SkillCatalogTokenEntry[];
}

/**
 * Loads every non-zero Skill current pointer without pagination or inner joins. Validation happens
 * before active/tombstone filtering so a broken inactive pointer cannot disappear into a healthy
 * residual projection.
 */
export const loadCurrentSkillCatalogSnapshot = async (
  db: CatalogDatabase,
): Promise<CurrentSkillCatalogSnapshot> => {
  const rows = await db
    .select({
      currentVersionId: platformSkills.currentVersionId,
      pointerRevision: platformSkills.revision,
      revision: platformResourceRevisions,
      skillId: platformSkills.id,
      version: platformSkillVersions,
    })
    .from(platformSkills)
    .leftJoin(
      platformResourceRevisions,
      and(
        eq(platformResourceRevisions.resourceType, 'skill'),
        eq(platformResourceRevisions.resourceId, platformSkills.id),
        eq(platformResourceRevisions.revision, platformSkills.revision),
      ),
    )
    .leftJoin(
      platformSkillVersions,
      and(
        eq(platformSkillVersions.skillId, platformSkills.id),
        eq(platformSkillVersions.id, platformSkills.currentVersionId),
      ),
    )
    .where(gt(platformSkills.revision, 0))
    .orderBy(asc(platformSkills.id));

  const validated = rows.map((row) => {
    const revision = row.revision;
    const version = row.version;
    if (!revision || !version) throw new PlatformCatalogTokenInvariantError();
    const snapshot = parsePlatformPublishedSkillSnapshot(revision.payload);
    if (!snapshot) throw new PlatformCatalogTokenInvariantError();
    if (
      !row.currentVersionId ||
      revision.resourceType !== 'skill' ||
      revision.resourceId !== row.skillId ||
      revision.revision !== row.pointerRevision ||
      (revision.status !== 'published' && revision.status !== 'archived') ||
      !isChecksum(revision.checksum) ||
      checksumPayload(revision.payload) !== revision.checksum ||
      snapshot.versionId !== row.currentVersionId ||
      version.id !== row.currentVersionId ||
      version.skillId !== row.skillId ||
      !isChecksum(version.checksum) ||
      platformSkillVersionChecksum({
        content: version.content,
        contentRef: version.contentRef,
        manifest: version.manifest,
        resources: version.resources,
      }) !== version.checksum
    ) {
      throw new PlatformCatalogTokenInvariantError();
    }
    return { revision, skillId: row.skillId, snapshot, version };
  });

  const builtinOverrideTombstones: string[] = [];
  const items: PlatformPublishedSkillView[] = [];
  const tokenEntries: SkillCatalogTokenEntry[] = [];
  for (const { revision, skillId, snapshot, version } of validated) {
    const tombstone =
      revision.status === 'archived' &&
      snapshot.skill.enabled &&
      snapshot.skill.allowBuiltinOverride &&
      snapshot.builtinOverrideTombstone === true;
    const active = revision.status === 'published' && snapshot.skill.enabled;
    if (!active && !tombstone) continue;
    tokenEntries.push({
      checksum: version.checksum,
      currentVersionId: version.id,
      revision: revision.revision,
      skillId,
      skillKey: snapshot.skill.skillKey,
      tombstone,
    });
    if (tombstone) {
      builtinOverrideTombstones.push(snapshot.skill.skillKey);
      continue;
    }
    items.push({
      allowBuiltinOverride: snapshot.skill.allowBuiltinOverride,
      description: snapshot.skill.description,
      displayName: snapshot.skill.displayName,
      distribution: snapshot.skill.distribution,
      revision: revision.revision,
      skillId,
      skillKey: snapshot.skill.skillKey,
      source: snapshot.skill.source,
      version: {
        checksum: version.checksum,
        content: version.content,
        contentRef: version.contentRef ?? null,
        createdAt: version.createdAt,
        createdBy: version.createdBy ?? null,
        id: version.id,
        manifest: version.manifest,
        resources: version.resources,
        skillId: version.skillId,
        validation: version.validationResult ?? null,
        version: version.version,
      },
    });
  }
  return { builtinOverrideTombstones, items, tokenEntries };
};
