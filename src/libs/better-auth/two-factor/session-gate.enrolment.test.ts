/**
 * Walks better-auth's real TOTP enable order against a live DB:
 *   updateUser({ twoFactorEnabled: true })
 *   createSession  ← the gate runs here, row still unverified
 *   adapter.update({ verified: true })
 *
 * A synthetic-orphan unit test cannot catch the gate clearing the flag mid-flight.
 *
 * @vitest-environment node
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { twoFactor, users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { enforceTwoFactorSessionGate } from './session-gate';

const db: LobeChatDatabase = await getTestDB();
const USER_ID = 'tf-enrol-order';

const cleanup = async () => {
  await db.delete(twoFactor);
  await db.delete(users);
};

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values({ id: USER_ID, twoFactorEnabled: false });
});

afterEach(async () => {
  await cleanup();
});

describe('enrolment session-create order', () => {
  it('does not clear twoFactorEnabled when the gate runs between the flag flip and verified=true', async () => {
    // /two-factor/enable: unverified factor row, flag still false.
    await db.insert(twoFactor).values({
      backupCodes: 'codes',
      id: 'tf-enrol',
      secret: 'secret',
      userId: USER_ID,
      verified: false,
    });

    // /two-factor/verify-totp step 1: flag on (session create is next).
    await db
      .update(users)
      .set({ twoFactorEnabled: true, updatedAt: new Date() })
      .where(eq(users.id, USER_ID));

    // Step 2: the gate. This used to treat (enabled, unverified) as an orphan.
    await enforceTwoFactorSessionGate({
      context: { path: '/two-factor/verify-totp' },
      db,
      userId: USER_ID,
    });

    // Step 3: row marked verified.
    await db.update(twoFactor).set({ verified: true }).where(eq(twoFactor.id, 'tf-enrol'));

    const [user] = await db.select().from(users).where(eq(users.id, USER_ID));
    expect(user?.twoFactorEnabled).toBe(true);
  });
});
