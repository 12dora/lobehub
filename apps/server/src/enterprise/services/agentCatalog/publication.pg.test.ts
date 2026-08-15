/**
 * De-drafted `save` / `create` under real PostgreSQL.
 *
 * The unit suites drive both writes through a transaction mock that merely invokes its callback,
 * so they can prove ordering but NOT atomicity. Here the whole body runs in one real transaction
 * and a failure is injected AFTER the immutable version row was inserted and the published
 * pointer was moved (a failing success-audit write, and a lost pointer CAS). Every such failure
 * must leave the identity, the version list and the success audit trail exactly as they were.
 *
 * Also covers the server-owned version label: it is allocated from the highest VALID SemVer the
 * Agent owns, so a malformed newest label can never make the next save collide on the
 * `(agent_id, version)` unique index.
 *
 * @vitest-environment node
 */
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  platformAgents,
  platformAgentVersions,
  platformAuditLogs,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { PlatformAgentAdminService } from './adminService';
import {
  CHECKSUM,
  config,
  createAdminPgFixture,
  dependencySnapshot,
  enabled,
} from './adminService.pg.fixture';
import { PlatformAgentRevisionConflictError } from './errors';
import { PlatformAgentPublicationService } from './publication';

const run = enabled ? describe : describe.skip;

/** Dependency revalidation is exercised by its own suites; this one is about the write body. */
const skipDependencyValidation = async () => undefined;
/** Post-commit fan-out is irrelevant here — every case fails before the commit. */
const noopInvalidation = { publish: async () => undefined };

run('de-drafted platform Agent write (PostgreSQL)', () => {
  const fx = createAdminPgFixture();
  const seedDraftAgent = (...args: Parameters<typeof fx.seedDraftAgent>) =>
    fx.seedDraftAgent(...args);
  const seedPublishedAgent = (...args: Parameters<typeof fx.seedPublishedAgent>) =>
    fx.seedPublishedAgent(...args);
  const currentIdentity = (...args: Parameters<typeof fx.currentIdentity>) =>
    fx.currentIdentity(...args);
  const pointerFor = (...args: Parameters<typeof fx.pointerFor>) => fx.pointerFor(...args);
  let db: LobeChatDatabase;
  beforeAll(() => {
    db = fx.db;
  });

  const execute = async (statements: string[]) => {
    for (const statement of statements) await db.execute(sql.raw(statement));
  };

  /**
   * Injected failure #1 — the in-transaction SUCCESS audit write fails. Failure audits (written
   * on a separate connection after the rollback) are deliberately still allowed through, so the
   * test can assert the redacted failure row survives while nothing else does.
   */
  const failingSuccessAudit = {
    install: () =>
      execute([
        `CREATE OR REPLACE FUNCTION test_block_success_audit() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.result = 'success' THEN
             RAISE EXCEPTION 'injected audit sink failure';
           END IF;
           RETURN NEW;
         END; $$`,
        `CREATE TRIGGER test_block_success_audit BEFORE INSERT ON platform_audit_logs
           FOR EACH ROW EXECUTE FUNCTION test_block_success_audit()`,
      ]),
    remove: () =>
      execute([
        'DROP TRIGGER IF EXISTS test_block_success_audit ON platform_audit_logs',
        'DROP FUNCTION IF EXISTS test_block_success_audit()',
      ]),
  };

  /**
   * Injected failure #2 — the published pointer move matches no row (a lost CAS), which happens
   * strictly AFTER `appendVersionCas` inserted the immutable version. `appendVersionCas` only
   * bumps `draft_sequence`, so the trigger lets it through and suppresses the pointer move alone.
   */
  const lostPointerCas = {
    install: () =>
      execute([
        `CREATE OR REPLACE FUNCTION test_block_pointer_move() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
             RETURN NULL;
           END IF;
           RETURN NEW;
         END; $$`,
        `CREATE TRIGGER test_block_pointer_move BEFORE UPDATE ON platform_agents
           FOR EACH ROW EXECUTE FUNCTION test_block_pointer_move()`,
      ]),
    remove: () =>
      execute([
        'DROP TRIGGER IF EXISTS test_block_pointer_move ON platform_agents',
        'DROP FUNCTION IF EXISTS test_block_pointer_move()',
      ]),
  };

  const withInjectedFailure = async (
    injection: { install: () => Promise<void>; remove: () => Promise<void> },
    body: () => Promise<void>,
  ) => {
    await injection.install();
    try {
      await body();
    } finally {
      await injection.remove();
    }
  };

  /**
   * Drizzle wraps the driver error ("Failed query: …") and keeps the raw one on `.cause`, so the
   * injected marker is matched against the whole chain rather than the outermost message.
   */
  const messageChain = (error: unknown): string => {
    const messages: string[] = [];
    let current = error as { cause?: unknown; message?: unknown } | undefined;
    for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
      if (typeof current.message === 'string') messages.push(current.message);
      current = current.cause as typeof current;
    }
    return messages.join(' | ');
  };

  const rejection = async (operation: Promise<unknown>): Promise<unknown> => {
    try {
      await operation;
      throw new Error('expected the de-drafted write to reject');
    } catch (error) {
      return error;
    }
  };

  const versionLabels = async (agentId: string) => {
    const rows = await db
      .select({ version: platformAgentVersions.version })
      .from(platformAgentVersions)
      .where(eq(platformAgentVersions.agentId, agentId))
      .orderBy(platformAgentVersions.version);
    return rows.map((row) => row.version);
  };

  const audits = async (action: string) =>
    db.select().from(platformAuditLogs).where(eq(platformAuditLogs.action, action));

  const saveService = () =>
    new PlatformAgentPublicationService(db, {
      invalidation: noopInvalidation,
      validateDependencies: skipDependencyValidation,
    });

  const adminService = () =>
    new PlatformAgentAdminService(db, {
      invalidation: noopInvalidation,
      validateDependencies: skipDependencyValidation,
    });

  const saveInput = async (agentId: string, reason: string) => ({
    ...(await pointerFor(agentId)),
    config: config('edited'),
    dependencySnapshot,
    reason,
  });

  const createInput = (agentKey: string, reason: string) => ({
    agentKey,
    config: config(agentKey),
    dependencySnapshot,
    isDefault: false,
    reason,
    systemKey: null,
  });

  describe('save atomicity', () => {
    it('discards the appended version and the pointer move when the success audit fails', async () => {
      await seedPublishedAgent('atomic-save-audit', 'atomic-save-audit');
      const before = await currentIdentity('atomic-save-audit');
      const input = await saveInput('atomic-save-audit', 'save with a failing audit sink');

      await withInjectedFailure(failingSuccessAudit, async () => {
        const error = await rejection(saveService().save('admin', input));
        expect(messageChain(error)).toMatch(/injected audit sink failure/);
      });

      // The whole body rolled back: identity pointer, revision and draft sequence are untouched
      // and the 1.0.1 row the transaction had already inserted is gone.
      const after = await currentIdentity('atomic-save-audit');
      expect(after.currentVersionId).toBe(before.currentVersionId);
      expect(after.revision).toBe(before.revision);
      expect(after.draftSequence).toBe(before.draftSequence);
      expect(after.status).toBe('published');
      expect(await versionLabels('atomic-save-audit')).toEqual(['1.0.0']);

      // No success audit was durable; only the redacted out-of-transaction failure row.
      const rows = await audits('admin.agents.save');
      expect(rows.map((row) => row.result)).toEqual(['failure']);
      expect(rows[0].afterDiff).toEqual({ error: 'platform_agent_publication_failed' });
    });

    it('discards the appended version when the published pointer CAS is lost', async () => {
      await seedPublishedAgent('atomic-save-cas', 'atomic-save-cas');
      const before = await currentIdentity('atomic-save-cas');
      const input = await saveInput('atomic-save-cas', 'save losing the pointer CAS');

      await withInjectedFailure(lostPointerCas, async () => {
        await expect(saveService().save('admin', input)).rejects.toBeInstanceOf(
          PlatformAgentRevisionConflictError,
        );
      });

      const after = await currentIdentity('atomic-save-cas');
      expect(after.currentVersionId).toBe(before.currentVersionId);
      expect(after.revision).toBe(before.revision);
      // `appendVersionCas` had already advanced the draft sequence inside the transaction —
      // the rollback takes that back too, so a retry can reuse the same CAS token.
      expect(after.draftSequence).toBe(before.draftSequence);
      expect(await versionLabels('atomic-save-cas')).toEqual(['1.0.0']);

      const rows = await audits('admin.agents.save');
      expect(rows.map((row) => row.result)).toEqual(['failure']);
    });
  });

  describe('create atomicity', () => {
    it('discards identity, first version and pointer when the success audit fails', async () => {
      await withInjectedFailure(failingSuccessAudit, async () => {
        const error = await rejection(
          adminService().create(
            'admin',
            createInput('atomic-create-audit', 'create with a failing audit sink'),
          ),
        );
        expect(messageChain(error)).toMatch(/injected audit sink failure/);
      });

      const identities = await db
        .select()
        .from(platformAgents)
        .where(eq(platformAgents.agentKey, 'atomic-create-audit'));
      expect(identities).toHaveLength(0);
      const [versions] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(platformAgentVersions);
      expect(versions.count).toBe(0);

      const rows = await audits('admin.agents.create');
      expect(rows.map((row) => row.result)).toEqual(['failure']);
      expect(rows[0].afterDiff).toEqual({ error: 'platform_agent_mutation_failed' });
    });

    it('discards identity and first version when the published pointer CAS is lost', async () => {
      await withInjectedFailure(lostPointerCas, async () => {
        await expect(
          adminService().create(
            'admin',
            createInput('atomic-create-cas', 'create losing the pointer CAS'),
          ),
        ).rejects.toBeInstanceOf(PlatformAgentRevisionConflictError);
      });

      const identities = await db
        .select()
        .from(platformAgents)
        .where(eq(platformAgents.agentKey, 'atomic-create-cas'));
      expect(identities).toHaveLength(0);
      const [versions] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(platformAgentVersions);
      expect(versions.count).toBe(0);

      const rows = await audits('admin.agents.create');
      expect(rows.map((row) => row.result)).toEqual(['failure']);
      expect(rows[0].afterDiff).toEqual({ error: 'revision_conflict' });
    });
  });

  describe('server-owned version label allocation', () => {
    it('bumps the highest valid SemVer instead of colliding on a malformed newest label', async () => {
      await seedPublishedAgent('label-agent', 'label-agent'); // seeds 1.0.0
      // A malformed legacy label created AFTER 1.0.0: reading only the newest row would fall
      // back to 1.0.0 and violate `(agent_id, version)` uniqueness.
      await db.insert(platformAgentVersions).values({
        agentId: 'label-agent',
        checksum: CHECKSUM,
        config: config('legacy'),
        dependencySnapshot,
        id: 'label-agent-legacy',
        version: 'legacy-snapshot',
      });

      const saved = await saveService().save(
        'admin',
        await saveInput('label-agent', 'save after a malformed label'),
      );
      expect(saved.version.version).toBe('1.0.1');
      expect(await versionLabels('label-agent')).toEqual(['1.0.0', '1.0.1', 'legacy-snapshot']);
    });

    it('parks the next label in the 0.0.x family when no existing label is valid SemVer', async () => {
      await seedDraftAgent('label-malformed', 'label-malformed');
      await db.insert(platformAgentVersions).values({
        agentId: 'label-malformed',
        checksum: CHECKSUM,
        config: config('legacy'),
        dependencySnapshot,
        id: 'label-malformed-v1',
        version: 'legacy-only',
      });

      const saved = await saveService().save(
        'admin',
        await saveInput('label-malformed', 'save with only malformed labels'),
      );
      // Never 1.0.0 — that label may already belong to a sibling row of the same Agent.
      expect(saved.version.version).toBe('0.0.2');
      expect(await versionLabels('label-malformed')).toEqual(['0.0.2', 'legacy-only']);
    });
  });
});
