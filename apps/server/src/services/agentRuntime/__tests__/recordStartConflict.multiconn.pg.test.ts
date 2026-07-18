/**
 * TRUE multi-connection PostgreSQL evidence for the platform-start conflict verification
 * (M10 PR-049 · RR4-4). recordStart's platform-start path runs the insert + conflict verification in
 * ONE transaction with a `FOR UPDATE` row lock, so a concurrent update/delete/replace can't slip
 * between the conflict and the check. PGlite is a single in-process connection and cannot reproduce
 * cross-connection transaction contention, so each case uses several INDEPENDENT `pg` Pool
 * connections (`max: 1`) — real backends contending for the same operation row.
 *
 * Runs ONLY when `TEST_SERVER_DB=1` and `DATABASE_TEST_URL` is set; otherwise `describe.skip`. The
 * single-connection logic (complete-binding, exact-idempotent, all fail-closed cases) is covered by
 * the PGlite `agentOperation.test.ts` suite, which always runs. Only fake test data is used.
 *
 * @vitest-environment node
 */
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { AgentOperationModel } from '@/database/models/agentOperation';
import * as schema from '@/database/schemas';
import { agentOperations } from '@/database/schemas';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';

const enabled = process.env.TEST_SERVER_DB === '1' && Boolean(process.env.DATABASE_TEST_URL);
const run = enabled ? describe : describe.skip;

const modelPin = {
  modelKey: 'chat',
  providerChecksum: 'b'.repeat(64),
  providerKey: 'openai',
  providerRevision: 1,
};
const pin = { checksum: 'a'.repeat(64), platformAgentId: 'pagt_1', versionId: 'pav_1' };
const complete = (overrides: Record<string, unknown> = {}) => ({
  assistantMessageId: 'asst-1',
  platformConnectors: [],
  platformModel: modelPin,
  platformOperation: pin,
  platformSkills: [],
  ...overrides,
});

run('recordStart platform-start conflict — true multi-connection PostgreSQL', () => {
  const connectionString = process.env.DATABASE_TEST_URL!;
  let db: LobeChatDatabase;
  const pools: Pool[] = [];
  const USER = 'rs-user';

  const workerModel = (): AgentOperationModel => {
    const pool = new Pool({ connectionString, max: 1 });
    pools.push(pool);
    return new AgentOperationModel(drizzle(pool, { schema }) as unknown as LobeChatDatabase, USER);
  };

  const start = (model: AgentOperationModel, metadata: Record<string, unknown>) =>
    model.recordStart({ metadata, operationId: 'op-1' }).then(
      () => ({ ok: true as const }),
      (error) => ({ error, ok: false as const }),
    );

  const cleanup = () =>
    db.execute(sql`TRUNCATE TABLE ${agentOperations}, ${users} RESTART IDENTITY CASCADE`);

  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    await cleanup();
    await db.insert(users).values([{ id: USER }, { id: 'rs-other' }]);
  });
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.end()));
    await cleanup();
  });
  afterAll(async () => {
    await Promise.all(pools.splice(0).map((p) => p.end()));
  });

  it('N concurrent identical complete starts across independent connections → one row, all idempotent', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => start(workerModel(), complete())),
    );
    expect(results.every((r) => r.ok)).toBe(true); // every connection resolves idempotently
    const rows = await db.select().from(agentOperations).where(eq(agentOperations.id, 'op-1'));
    expect(rows).toHaveLength(1);
  });

  it('concurrent starts with DIFFERENT pins → exactly one wins, the other fails closed', async () => {
    const [a, b] = await Promise.all([
      start(workerModel(), complete()),
      start(workerModel(), complete({ platformOperation: { ...pin, versionId: 'pav_OTHER' } })),
    ]);
    const oks = [a, b].filter((r) => r.ok).length;
    const conflicts = [a, b].filter((r) => !r.ok).length;
    expect(oks).toBe(1); // the insert winner
    expect(conflicts).toBe(1); // the loser verifies the row and fails closed
  });

  it('TOCTOU: a start racing a concurrent replace-to-inconsistent resolves as idempotent OR conflict, never ordinary/latest', async () => {
    // Seed the genuine complete row first.
    await start(workerModel(), complete());

    // One connection holds a tx that mutates the row's pins to INCONSISTENT, then parks; a second
    // connection's start must serialize behind the FOR UPDATE lock and observe a consistent outcome.
    const mutatorPool = new Pool({ connectionString, max: 1 });
    pools.push(mutatorPool);
    const mutatorDb = drizzle(mutatorPool, { schema }) as unknown as LobeChatDatabase;

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));

    const mutatorTx = mutatorDb.transaction(async (tx) => {
      await tx
        .update(agentOperations)
        .set({
          metadata: sql`jsonb_set(${agentOperations.metadata}, '{platformOperation,versionId}', '"pav_MUTATED"'::jsonb)`,
        })
        .where(eq(agentOperations.id, 'op-1'));
      holding();
      await released;
    });
    await held;

    const startResult = start(workerModel(), complete());
    await new Promise((r) => setTimeout(r, 200));
    release();
    await mutatorTx;
    const outcome = await startResult;

    // The start saw the mutated (inconsistent) row under the lock → conflict; it NEVER silently
    // continued on it. And the row is never an ordinary/no-pin row.
    expect(outcome.ok).toBe(false);
    const [row] = await db.select().from(agentOperations).where(eq(agentOperations.id, 'op-1'));
    expect((row?.metadata as { platformOperation?: unknown })?.platformOperation).toBeDefined();
  });

  it('a start after a committed DELETE of the row cleanly inserts a fresh complete row (no conflict)', async () => {
    // Seed a genuine complete row, then DELETE it (committed) from an independent connection. The row
    // the previous start created is gone, so a later identical start finds no conflicting row and its
    // `onConflictDoNothing` insert wins outright — exactly one complete row, never a fail-closed miss.
    await start(workerModel(), complete());
    const deleterPool = new Pool({ connectionString, max: 1 });
    pools.push(deleterPool);
    const deleter = drizzle(deleterPool, { schema }) as unknown as LobeChatDatabase;
    await deleter.delete(agentOperations).where(eq(agentOperations.id, 'op-1'));

    const outcome = await start(workerModel(), complete());
    expect(outcome.ok).toBe(true);
    const rows = await db.select().from(agentOperations).where(eq(agentOperations.id, 'op-1'));
    expect(rows).toHaveLength(1);
    expect((rows[0]?.metadata as { platformOperation?: unknown })?.platformOperation).toBeDefined();
  });

  it('a start after a committed DELETE+REINSERT (replace) with different pins fails closed on the replaced row', async () => {
    // The row is DELETEd and REINSERTed with an INCONSISTENT pin (a full replace) on an independent
    // connection, all committed, before the racing start runs. The start's insert no-ops (id exists),
    // then the FOR UPDATE select observes the REPLACED row → not byte-for-byte idempotent → fail
    // closed. It must never adopt the replaced row as its own, and never downgrade to ordinary/latest.
    await start(workerModel(), complete());
    const replacerPool = new Pool({ connectionString, max: 1 });
    pools.push(replacerPool);
    const replacer = drizzle(replacerPool, { schema }) as unknown as LobeChatDatabase;
    await replacer.transaction(async (tx) => {
      await tx.delete(agentOperations).where(eq(agentOperations.id, 'op-1'));
      await tx.insert(agentOperations).values({
        id: 'op-1',
        metadata: complete({ platformOperation: { ...pin, versionId: 'pav_REPLACED' } }) as never,
        startedAt: new Date(),
        status: 'running',
        userId: USER,
      });
    });

    const outcome = await start(workerModel(), complete());
    expect(outcome.ok).toBe(false);
    const [row] = await db.select().from(agentOperations).where(eq(agentOperations.id, 'op-1'));
    // The replaced pin is intact — the losing start neither overwrote it nor ordinary-downgraded it.
    expect(
      (row?.metadata as { platformOperation?: { versionId?: string } })?.platformOperation,
    ).toMatchObject({ versionId: 'pav_REPLACED' });
  });
});
