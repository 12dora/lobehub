import { and, eq, sql } from 'drizzle-orm';

import {
  platformResourceRevisions,
  platformSkills,
  platformSkillVersions,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export const publishedSkillSelect = {
  payload: platformResourceRevisions.payload,
  revision: platformResourceRevisions.revision,
  skillId: platformSkills.id,
  status: platformResourceRevisions.status,
  version: platformSkillVersions,
};

export const publishedSkillExactSelect = {
  ...publishedSkillSelect,
  skillKey: platformSkills.skillKey,
};

export type PublishedSkillJoinRow = {
  payload: (typeof platformResourceRevisions.$inferSelect)['payload'];
  revision: (typeof platformResourceRevisions.$inferSelect)['revision'];
  skillId: (typeof platformSkills.$inferSelect)['id'];
  status: (typeof platformResourceRevisions.$inferSelect)['status'];
  version: typeof platformSkillVersions.$inferSelect;
};

const publishedRevisionJoin = and(
  eq(platformResourceRevisions.resourceType, 'skill'),
  eq(platformResourceRevisions.resourceId, platformSkills.id),
);

const publishedVersionJoin = and(
  eq(platformSkillVersions.skillId, platformSkills.id),
  eq(platformSkillVersions.id, sql<string>`${platformResourceRevisions.payload}->>'versionId'`),
);

export const joinPublishedSkillVersions = (db: LobeChatDatabase | Transaction) =>
  db
    .select(publishedSkillSelect)
    .from(platformSkills)
    .innerJoin(platformResourceRevisions, publishedRevisionJoin)
    .innerJoin(platformSkillVersions, publishedVersionJoin);

export const joinPublishedSkillVersionsExact = (db: LobeChatDatabase | Transaction) =>
  db
    .select(publishedSkillExactSelect)
    .from(platformSkills)
    .innerJoin(platformResourceRevisions, publishedRevisionJoin)
    .innerJoin(platformSkillVersions, publishedVersionJoin);
