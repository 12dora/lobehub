// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { twoFactor, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import {
  clearOrphanedTwoFactorEnabled,
  getTwoFactorEnrollmentState,
  isStaleTwoFactorOrphan,
  TWO_FACTOR_ORPHAN_GRACE_MS,
} from '../twoFactor';

const db: LobeChatDatabase = await getTestDB();

const IDS = {
  disabled: 'tf-disabled',
  orphanedNone: 'tf-orphaned-none',
  orphanedUnverified: 'tf-orphaned-unverified',
  verified: 'tf-verified',
};

const cleanup = async () => {
  await db.delete(twoFactor);
  await db.delete(users);
};

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values([
    { id: IDS.disabled, twoFactorEnabled: false },
    { id: IDS.orphanedNone, twoFactorEnabled: true },
    { id: IDS.orphanedUnverified, twoFactorEnabled: true },
    { id: IDS.verified, twoFactorEnabled: true },
  ]);
  await db.insert(twoFactor).values([
    {
      backupCodes: 'codes-unverified',
      id: 'row-unverified',
      secret: 'secret-unverified',
      userId: IDS.orphanedUnverified,
      verified: false,
    },
    {
      backupCodes: 'codes-verified',
      id: 'row-verified',
      secret: 'secret-verified',
      userId: IDS.verified,
      verified: true,
    },
  ]);
});

afterEach(async () => {
  await cleanup();
});

describe('getTwoFactorEnrollmentState', () => {
  it('reports a verified enrolment', async () => {
    await expect(getTwoFactorEnrollmentState(db, IDS.verified)).resolves.toMatchObject({
      enabled: true,
      hasUnverifiedFactor: false,
      hasVerifiedFactor: true,
    });
  });

  it('treats an enabled flag with only an unverified row as an in-flight or orphan candidate', async () => {
    await expect(getTwoFactorEnrollmentState(db, IDS.orphanedUnverified)).resolves.toMatchObject({
      enabled: true,
      hasUnverifiedFactor: true,
      hasVerifiedFactor: false,
    });
  });

  it('treats an enabled flag with no row as a stale orphan', async () => {
    const state = await getTwoFactorEnrollmentState(db, IDS.orphanedNone);
    expect(state).toMatchObject({
      enabled: true,
      hasUnverifiedFactor: false,
      hasVerifiedFactor: false,
    });
    expect(isStaleTwoFactorOrphan(state)).toBe(true);
  });

  it('leaves a password-only account alone', async () => {
    await expect(getTwoFactorEnrollmentState(db, IDS.disabled)).resolves.toMatchObject({
      enabled: false,
      hasUnverifiedFactor: false,
      hasVerifiedFactor: false,
    });
  });
});

describe('clearOrphanedTwoFactorEnabled', () => {
  it('does not touch a user who has a verified factor', async () => {
    await expect(clearOrphanedTwoFactorEnabled(db, IDS.verified)).resolves.toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, IDS.verified));
    expect(row?.twoFactorEnabled).toBe(true);
  });

  it('does not clear a fresh unverified enrolment still inside the grace window', async () => {
    await db
      .update(users)
      .set({ updatedAt: new Date() })
      .where(eq(users.id, IDS.orphanedUnverified));
    await expect(clearOrphanedTwoFactorEnabled(db, IDS.orphanedUnverified)).resolves.toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, IDS.orphanedUnverified));
    expect(row?.twoFactorEnabled).toBe(true);
  });

  it('clears the flag when the unverified row is older than the grace period', async () => {
    await db
      .update(users)
      .set({ updatedAt: new Date(Date.now() - TWO_FACTOR_ORPHAN_GRACE_MS - 1000) })
      .where(eq(users.id, IDS.orphanedUnverified));
    await expect(clearOrphanedTwoFactorEnabled(db, IDS.orphanedUnverified)).resolves.toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, IDS.orphanedUnverified));
    expect(row?.twoFactorEnabled).toBe(false);
  });

  it('clears the flag when no factor row exists', async () => {
    await expect(clearOrphanedTwoFactorEnabled(db, IDS.orphanedNone)).resolves.toBe(true);
    const [row] = await db.select().from(users).where(eq(users.id, IDS.orphanedNone));
    expect(row?.twoFactorEnabled).toBe(false);
  });

  it('is a no-op for an already-disabled account', async () => {
    await expect(clearOrphanedTwoFactorEnabled(db, IDS.disabled)).resolves.toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, IDS.disabled));
    expect(row?.twoFactorEnabled).toBe(false);
  });
});
