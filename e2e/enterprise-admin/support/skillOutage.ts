/**
 * Real isolated Skill catalog outage: insert a broken published-pointer skill
 * (revision>0, missing immutable version join) so loadCurrentSkillCatalogSnapshot
 * fails closed → readiness.skills=false. Personal agent_skills remain intact.
 *
 * Cache bust via Redis skill-catalog / managed-policy scope epochs.
 */
import Redis from 'ioredis';
import { Pool } from 'pg';

export const OUTAGE_SKILL_ID = 'pskill_e2e_outage_probe';
export const OUTAGE_SKILL_KEY = 'e2e.skill.outage.probe';

export interface SkillOutageHandle {
  databaseUrl: string;
  redisUrl: string;
  restore: () => Promise<void>;
}

export interface UserSkillArtifacts {
  agentSkillIds: string[];
  agentSkills: number;
  documentIds: string[];
  documents: number;
  /** Rows matching a suite identifier (must stay absent after denied create). */
  matchingIdentifiers: string[];
}

const bumpSkillCatalogEpoch = async (redisUrl: string): Promise<void> => {
  if (!redisUrl) throw new Error('redisUrl required to bust skill-catalog cache epoch');
  const client = new Redis(redisUrl, {
    connectTimeout: 3_000,
    maxRetriesPerRequest: 1,
  });
  try {
    await client.incr('platform:config:scope:skill-catalog:version');
    await client.incr('platform:config:scope:skill-runtime:version');
    await client.incr('platform:config:scope:managed-policy:version');
  } finally {
    client.disconnect();
  }
};

/**
 * Broken pointer: revision>0 so the authority scan includes it, but joins to
 * platform_resource_revisions / platform_skill_versions are missing → throw → readiness false.
 */
export const induceSkillCatalogOutage = async (params: {
  databaseUrl: string;
  redisUrl: string;
}): Promise<SkillOutageHandle> => {
  const pool = new Pool({ connectionString: params.databaseUrl });
  const now = new Date().toISOString();
  try {
    await pool.query(
      `INSERT INTO platform_skills (
         id, skill_key, name, description, source, distribution,
         allow_builtin_override, enabled, current_version_id, status, revision, draft_sequence,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'E2E Outage Probe', 'forces skill catalog readiness fail-closed',
         'uploaded', 'optional', false, true, NULL, 'draft', 1, 0, $3, $3
       )
       ON CONFLICT (id) DO UPDATE SET revision = 1, status = 'draft', current_version_id = NULL, updated_at = $3`,
      [OUTAGE_SKILL_ID, OUTAGE_SKILL_KEY, now],
    );
  } finally {
    await pool.end();
  }

  await bumpSkillCatalogEpoch(params.redisUrl);

  return {
    databaseUrl: params.databaseUrl,
    redisUrl: params.redisUrl,
    restore: async () => restoreSkillCatalogOutage(params),
  };
};

export const restoreSkillCatalogOutage = async (params: {
  databaseUrl: string;
  redisUrl: string;
}): Promise<void> => {
  const pool = new Pool({ connectionString: params.databaseUrl });
  try {
    await pool.query(`DELETE FROM platform_skills WHERE id = $1 OR skill_key = $2`, [
      OUTAGE_SKILL_ID,
      OUTAGE_SKILL_KEY,
    ]);
  } finally {
    await pool.end();
  }
  await bumpSkillCatalogEpoch(params.redisUrl);
};

/**
 * Exact user skill/document inventory. Query failures hard-fail (no swallowed catches).
 * Prefer suite identifiers over only total counts.
 */
export const countUserSkillArtifacts = async (
  databaseUrl: string,
  userId: string,
  suiteIdentifier?: string,
): Promise<UserSkillArtifacts> => {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const skills = await pool.query(
      `SELECT id, identifier FROM agent_skills WHERE user_id = $1 ORDER BY id`,
      [userId],
    );
    const docs = await pool.query(`SELECT id FROM documents WHERE user_id = $1 ORDER BY id`, [
      userId,
    ]);
    const agentSkillIds = skills.rows.map((r) => String(r.id));
    const identifiers = skills.rows
      .map((r) => (r.identifier == null ? null : String(r.identifier)))
      .filter((v): v is string => Boolean(v));
    const documentIds = docs.rows.map((r) => String(r.id));
    const matchingIdentifiers = suiteIdentifier
      ? identifiers.filter((id) => id === suiteIdentifier)
      : [];
    return {
      agentSkillIds,
      agentSkills: agentSkillIds.length,
      documentIds,
      documents: documentIds.length,
      matchingIdentifiers,
    };
  } finally {
    await pool.end();
  }
};
