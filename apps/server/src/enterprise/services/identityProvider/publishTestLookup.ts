import { and, desc, eq, gt, lte, sql } from 'drizzle-orm';

import { platformIdentityProviderTestAttempts } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

export const SUCCESSFUL_TEST_MAX_AGE_MS = 10 * 60 * 1000;

export const successfulTestWhere = (now: Date, cutoff: Date) =>
  and(
    eq(platformIdentityProviderTestAttempts.status, 'succeeded'),
    sql`${platformIdentityProviderTestAttempts.result}->>'valid' = 'true'`,
    gt(platformIdentityProviderTestAttempts.expiresAt, now),
    gt(platformIdentityProviderTestAttempts.completedAt, cutoff),
    lte(platformIdentityProviderTestAttempts.completedAt, now),
  );

export const selectSuccessfulPublishTest = async (
  dbOrTx: LobeChatDatabase | Transaction,
  binding: {
    id: string;
    revision: number;
    secretFingerprint: string;
    secretRef: string;
  },
) => {
  const testCutoff = new Date(Date.now() - SUCCESSFUL_TEST_MAX_AGE_MS);
  const testNow = new Date();
  const [successfulTest] = await dbOrTx
    .select({ id: platformIdentityProviderTestAttempts.id })
    .from(platformIdentityProviderTestAttempts)
    .where(
      and(
        eq(platformIdentityProviderTestAttempts.providerId, binding.id),
        eq(platformIdentityProviderTestAttempts.providerRevision, binding.revision),
        eq(
          platformIdentityProviderTestAttempts.providerSecretFingerprint,
          binding.secretFingerprint,
        ),
        eq(platformIdentityProviderTestAttempts.providerSecretRef, binding.secretRef),
        successfulTestWhere(testNow, testCutoff),
      ),
    )
    .orderBy(desc(platformIdentityProviderTestAttempts.completedAt))
    .limit(1);
  return successfulTest;
};
