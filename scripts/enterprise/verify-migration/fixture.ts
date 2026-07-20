import type { CoreFixtureTable } from './constants';
import { CORE_FIXTURE_TABLES } from './constants';

/**
 * Representative non-secret synthetic 2.2.10 fixture.
 * Values intentionally avoid real credentials, private keys, and production identifiers.
 */
export const SYNTHETIC_FIXTURE_IDS = {
  agentId: 'agt_m15q03_fixture_01',
  apiKeyId: 'apk_m15q03_fixture_01',
  messageId: 'msg_m15q03_fixture_01',
  sessionId: 'ses_m15q03_fixture_01',
  topicId: 'tpc_m15q03_fixture_01',
  userId: 'usr_m15q03_fixture_01',
} as const;

/** Expected row counts after loading the synthetic fixture (baseline schema). */
export const SYNTHETIC_FIXTURE_ROW_COUNTS = {
  agents: 1,
  api_keys: 1,
  messages: 1,
  sessions: 1,
  topics: 1,
  user_settings: 1,
  users: 1,
} as const satisfies Record<CoreFixtureTable, number>;

/**
 * Ordered SQL statements for the synthetic fixture.
 * Inserts only non-secret representative data compatible with the 0116 schema.
 */
export const buildSyntheticFixtureStatements = (): string[] => {
  const { agentId, apiKeyId, messageId, sessionId, topicId, userId } = SYNTHETIC_FIXTURE_IDS;

  return [
    `INSERT INTO "users" ("id", "username", "email", "normalized_email", "email_verified", "full_name")
     VALUES ('${userId}', 'm15q03_fixture_user', 'fixture.user@example.invalid', 'fixture.user@example.invalid', true, 'Migration Fixture User')
     ON CONFLICT ("id") DO NOTHING`,
    `INSERT INTO "user_settings" ("id", "general")
     VALUES ('${userId}', '{"fixture":true}'::jsonb)
     ON CONFLICT ("id") DO NOTHING`,
    `INSERT INTO "agents" ("id", "title", "user_id", "model", "provider")
     VALUES ('${agentId}', 'Fixture Agent', '${userId}', 'fixture-model', 'fixture-provider')
     ON CONFLICT ("id") DO NOTHING`,
    `INSERT INTO "sessions" ("id", "slug", "title", "type", "user_id")
     VALUES ('${sessionId}', 'fixture-session-slug', 'Fixture Session', 'agent', '${userId}')
     ON CONFLICT ("id") DO NOTHING`,
    `INSERT INTO "topics" ("id", "title", "session_id", "agent_id", "user_id")
     VALUES ('${topicId}', 'Fixture Topic', '${sessionId}', '${agentId}', '${userId}')
     ON CONFLICT ("id") DO NOTHING`,
    `INSERT INTO "messages" ("id", "role", "content", "user_id", "session_id", "topic_id", "agent_id")
     VALUES ('${messageId}', 'user', 'synthetic fixture message for migration compat', '${userId}', '${sessionId}', '${topicId}', '${agentId}')
     ON CONFLICT ("id") DO NOTHING`,
    // api_keys.key is required historically; store a clearly fake opaque value, not a live secret.
    `INSERT INTO "api_keys" ("id", "name", "key", "key_hash", "enabled", "user_id")
     VALUES ('${apiKeyId}', 'fixture-key', 'fixture-opaque-not-a-secret', 'fixture-hash-deadbeef', true, '${userId}')
     ON CONFLICT ("id") DO NOTHING`,
  ];
};

export const isSecretFreeFixtureText = (text: string): boolean => {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text)) return false;
  if (/postgres(?:ql)?:\/\//iu.test(text)) return false;
  if (/(?:sk|pk|rk)[_-]live[_-]/iu.test(text)) return false;
  if (/(?:password|secret|token)\s*[:=]\s*\S+/iu.test(text)) return false;
  return true;
};

export const assertSyntheticFixtureIsSecretFree = (): void => {
  const statements = buildSyntheticFixtureStatements().join('\n');
  if (!isSecretFreeFixtureText(statements)) {
    throw new Error('Synthetic fixture failed secret-free validation');
  }
  for (const table of CORE_FIXTURE_TABLES) {
    if (!(table in SYNTHETIC_FIXTURE_ROW_COUNTS)) {
      throw new Error(`Missing fixture row count for ${table}`);
    }
  }
};
