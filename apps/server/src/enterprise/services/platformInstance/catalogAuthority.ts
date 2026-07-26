import { isRecord } from '@lobechat/utils/object';
import { and, asc, eq, gt, sql } from 'drizzle-orm';

import {
  checksumPayload,
  parsePlatformPublishedSkillSnapshot,
  PlatformCatalogAuthorityModel,
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
import type { PlatformRevisionToken } from '@/server/enterprise/contracts/platformInstanceStatus';

import type {
  AiCatalogTokenEntry,
  SkillCatalogBuiltinTokenEntry,
  SkillCatalogTokenEntry,
} from './catalogTokens';
import {
  aiCatalogAuthorityToken,
  buildAiCatalogRevisionToken,
  buildSkillCatalogRevisionToken,
  invalidateAiCatalogAuthorityToken,
  invalidateSkillCatalogAuthorityToken,
  PlatformCatalogTokenInvariantError,
  skillCatalogAuthorityToken,
} from './catalogTokens';

/** Re-export writer-side invalidation so AI/skill publish paths can advance the poll token. */
export { invalidateAiCatalogAuthorityToken, invalidateSkillCatalogAuthorityToken };

type CatalogDatabase = LobeChatDatabase | Transaction;

const isChecksum = (value: string | null | undefined): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

const aiTargetRebuilds = new Map<string, Promise<PlatformRevisionToken>>();
const skillTargetRebuilds = new Map<string, Promise<PlatformRevisionToken>>();

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

/**
 * Lightweight AI catalog token entries for domain-target polling.
 * Selects only pointer IDs, revisions, stored checksums, status, and secret fingerprints —
 * never revision payloads — and trusts stored checksums (full rehash stays on publish/runtime).
 *
 * Not called on the steady-state health-poll path (see {@link loadCurrentAiCatalogTargetToken}).
 */
export const loadCurrentAiCatalogTargetTokenEntries = async (
  db: CatalogDatabase,
): Promise<AiCatalogTokenEntry[]> => {
  const rows = await db
    .select({
      checksum: platformResourceRevisions.checksum,
      pointerRevision: platformAiProviders.revision,
      providerId: platformAiProviders.id,
      providerKey: platformAiProviders.providerKey,
      revisionNumber: platformResourceRevisions.revision,
      secretFingerprint: platformResourceRevisions.secretFingerprint,
      status: platformResourceRevisions.status,
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

  const tokenEntries: AiCatalogTokenEntry[] = [];
  for (const row of rows) {
    if (
      !row.checksum ||
      row.pointerRevision <= 0 ||
      row.revisionNumber !== row.pointerRevision ||
      (row.status !== 'published' && row.status !== 'archived') ||
      !isChecksum(row.checksum)
    ) {
      throw new PlatformCatalogTokenInvariantError();
    }
    if (row.status === 'archived') continue;
    tokenEntries.push({
      checksum: row.checksum,
      providerId: row.providerId,
      providerKey: row.providerKey,
      revision: row.pointerRevision,
      secretFingerprint: row.secretFingerprint ?? null,
    });
  }
  return tokenEntries;
};

/**
 * Lightweight AI catalog token projection for system-health / domain-target polling.
 *
 * Steady-state path (persisted generation unchanged + warm local slot):
 * one PK read of `platform_catalog_authority`, **zero** catalog-wide scans/hashes.
 *
 * On miss (generation advanced by another instance / local invalidate / cold start):
 * rebuild once from lightweight pointer rows, then cache under that generation.
 */
export const loadCurrentAiCatalogTargetToken = async (
  db: CatalogDatabase,
): Promise<PlatformRevisionToken> => {
  aiCatalogAuthorityToken.recordPkRead();
  const { generation } = await new PlatformCatalogAuthorityModel(db).peekGeneration('ai_catalog');
  const hit = aiCatalogAuthorityToken.peekAt(generation);
  if (hit) return hit;

  const epoch = aiCatalogAuthorityToken.epoch;
  const rebuildKey = `${generation}:${epoch}`;
  const inFlight = aiTargetRebuilds.get(rebuildKey);
  if (inFlight) return inFlight;

  const rebuild = (async () => {
    const tokenEntries = await loadCurrentAiCatalogTargetTokenEntries(db);
    aiCatalogAuthorityToken.recordPkRead();
    const current = await new PlatformCatalogAuthorityModel(db).peekGeneration('ai_catalog');
    if (current.generation !== generation || aiCatalogAuthorityToken.epoch !== epoch) {
      return loadCurrentAiCatalogTargetToken(db);
    }
    return aiCatalogAuthorityToken.put(
      buildAiCatalogRevisionToken(tokenEntries),
      { entryHashes: 1, rowsScanned: tokenEntries.length },
      generation,
    );
  })();
  aiTargetRebuilds.set(rebuildKey, rebuild);
  try {
    return await rebuild;
  } finally {
    if (aiTargetRebuilds.get(rebuildKey) === rebuild) aiTargetRebuilds.delete(rebuildKey);
  }
};

/**
 * Lightweight skill catalog token entries for domain-target polling.
 *
 * Bounds I/O for the 3s system-health poll:
 * - never selects version content / manifest / resources
 * - never rehashes revision payloads; only extracts the scalar `payload.versionId`
 *   so a retargeted `currentVersionId` still fails closed (matches full-snapshot authority)
 * - trusts stored version checksums (full rehash stays on publish/runtime)
 * - effective enabled/tombstone state comes from scalar immutable-payload fields
 *
 * Called only on catalog-authority cache miss / rebuild — not on the O(1) steady-state path.
 */
export const loadCurrentSkillCatalogTargetTokenEntries = async (
  db: CatalogDatabase,
): Promise<SkillCatalogTokenEntry[]> => {
  const rows = await db
    .select({
      checksum: platformSkillVersions.checksum,
      currentVersionId: platformSkills.currentVersionId,
      pointerRevision: platformSkills.revision,
      publishedEnabled: sql<
        boolean | null
      >`(${platformResourceRevisions.payload}->'skill'->>'enabled')::boolean`,
      publishedTombstone: sql<
        boolean | null
      >`(${platformResourceRevisions.payload}->>'builtinOverrideTombstone')::boolean`,
      // Scalar extract only — not a full payload load/rehash; restores fail-closed
      // when currentVersionId is retargeted away from the published snapshot.
      publishedVersionId: sql<string | null>`(${platformResourceRevisions.payload}->>'versionId')`,
      revisionNumber: platformResourceRevisions.revision,
      skillId: platformSkills.id,
      skillKey: platformSkills.skillKey,
      status: platformResourceRevisions.status,
      versionId: platformSkillVersions.id,
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

  const tokenEntries: SkillCatalogTokenEntry[] = [];
  for (const row of rows) {
    if (
      !row.currentVersionId ||
      !row.versionId ||
      !row.checksum ||
      !row.publishedVersionId ||
      row.revisionNumber !== row.pointerRevision ||
      row.versionId !== row.currentVersionId ||
      // Fail closed on pointer/snapshot version mismatch (same invariant as full snapshot).
      row.publishedVersionId !== row.currentVersionId ||
      (row.status !== 'published' && row.status !== 'archived') ||
      !isChecksum(row.checksum)
    ) {
      throw new PlatformCatalogTokenInvariantError();
    }
    // Effective state belongs to the immutable publication. A disabled mutable
    // pointer can still publish an enabled builtin-override tombstone.
    const tombstone =
      row.status === 'archived' && row.publishedTombstone === true && row.publishedEnabled === true;
    const active = row.status === 'published' && row.publishedEnabled === true;
    if (!active && !tombstone) continue;
    tokenEntries.push({
      checksum: row.checksum,
      currentVersionId: row.versionId,
      revision: row.pointerRevision,
      skillId: row.skillId,
      skillKey: row.skillKey,
      tombstone,
    });
  }
  return tokenEntries;
};

/** Bounded skill-catalog target token (platform entries + caller-supplied builtins). */
export const buildCurrentSkillCatalogTargetToken = (input: {
  builtins: readonly SkillCatalogBuiltinTokenEntry[];
  platform: readonly SkillCatalogTokenEntry[];
}): PlatformRevisionToken => buildSkillCatalogRevisionToken(input);

/**
 * Skill catalog authority token for domain-target polling.
 *
 * Steady-state path: one PK generation read + O(1) slot compare — **no** builtin
 * reconstruction and **no** platform catalog scan.
 *
 * On miss only: load builtins (caller-supplied factory) + platform pointer entries once.
 */
export const loadCurrentSkillCatalogTargetToken = async (
  db: CatalogDatabase,
  loadBuiltins: () => readonly SkillCatalogBuiltinTokenEntry[],
): Promise<PlatformRevisionToken> => {
  skillCatalogAuthorityToken.recordPkRead();
  const { generation } = await new PlatformCatalogAuthorityModel(db).peekGeneration(
    'skill_catalog',
  );
  const hit = skillCatalogAuthorityToken.peekAt(generation);
  if (hit) return hit;

  const epoch = skillCatalogAuthorityToken.epoch;
  const rebuildKey = `${generation}:${epoch}`;
  const inFlight = skillTargetRebuilds.get(rebuildKey);
  if (inFlight) return inFlight;

  const rebuild = (async () => {
    const builtins = loadBuiltins();
    const platform = await loadCurrentSkillCatalogTargetTokenEntries(db);
    skillCatalogAuthorityToken.recordPkRead();
    const current = await new PlatformCatalogAuthorityModel(db).peekGeneration('skill_catalog');
    if (current.generation !== generation || skillCatalogAuthorityToken.epoch !== epoch) {
      return loadCurrentSkillCatalogTargetToken(db, loadBuiltins);
    }
    return skillCatalogAuthorityToken.put(
      buildSkillCatalogRevisionToken({ builtins, platform }),
      { entryHashes: 1, rowsScanned: builtins.length + platform.length },
      generation,
    );
  })();
  skillTargetRebuilds.set(rebuildKey, rebuild);
  try {
    return await rebuild;
  } finally {
    if (skillTargetRebuilds.get(rebuildKey) === rebuild) skillTargetRebuilds.delete(rebuildKey);
  }
};
