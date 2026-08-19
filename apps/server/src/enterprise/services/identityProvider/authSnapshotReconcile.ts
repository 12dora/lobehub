import { and, eq, sql } from 'drizzle-orm';

import { platformIdentityProviders } from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

export interface AuthSnapshotReconcileTarget {
  environmentShadowed: { providerId: string }[];
  identityRevision: string | null;
  providers: { providerId: string }[];
}

export interface AuthSnapshotPendingPublished {
  blockedCategory: 'environment_provider_shadowed' | null;
  providerId: string;
  providerKey: string;
  publishedRevision: number;
}

export const isActive = (
  instance: {
    activeIdentityRevision: string | null;
    health: 'degraded' | 'healthy';
    startupSource: 'break_glass' | 'database' | 'environment' | 'lkg';
  },
  target: Pick<AuthSnapshotReconcileTarget, 'identityRevision' | 'providers'>,
) => {
  if (
    !target.identityRevision ||
    instance.activeIdentityRevision !== target.identityRevision ||
    instance.health !== 'healthy'
  ) {
    return false;
  }
  if (instance.startupSource === 'database') return true;
  // Empty canonical DB set + env SSO loads as source:environment with the
  // empty-set identity digest. Treat that as converged so tombstones can
  // reconcile instead of leaving restart pending forever.
  return instance.startupSource === 'environment' && target.providers.length === 0;
};

export const reconcilePendingPublished = async (
  tx: Transaction,
  input: {
    allFreshInstancesActive: boolean;
    pendingRows: {
      activationRevision: number | null;
      id: string;
      providerKey: string;
    }[];
    target: AuthSnapshotReconcileTarget;
  },
): Promise<AuthSnapshotPendingPublished[]> => {
  const { pendingRows, target } = input;
  let pendingPublished = pendingRows.flatMap((row) =>
    row.activationRevision
      ? [
          {
            blockedCategory: target.environmentShadowed.some(
              (provider) => provider.providerId === row.id,
            )
              ? ('environment_provider_shadowed' as const)
              : null,
            providerId: row.id,
            providerKey: row.providerKey,
            publishedRevision: row.activationRevision,
          },
        ]
      : [],
  );
  if (input.allFreshInstancesActive && target.identityRevision) {
    const canonicalProviderIds = new Set(target.providers.map((provider) => provider.providerId));
    const reconciled = new Set<string>();
    for (const row of pendingRows) {
      if (!row.activationRevision) continue;
      if (canonicalProviderIds.has(row.id)) {
        // Live publish: mark active once every fresh instance reports the target.
        const [updated] = await tx
          .update(platformIdentityProviders)
          .set({ status: 'active', updatedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(platformIdentityProviders.id, row.id),
              eq(platformIdentityProviders.status, 'pending_restart'),
              eq(platformIdentityProviders.activationRevision, row.activationRevision),
              eq(platformIdentityProviders.revision, row.activationRevision),
            ),
          )
          .returning({ id: platformIdentityProviders.id });
        if (updated) reconciled.add(updated.id);
        continue;
      }
      // Tombstone / removal: provider is no longer in the live target set.
      // Reconcile to disabled only after every fresh instance reports the reduced target.
      const [updated] = await tx
        .update(platformIdentityProviders)
        .set({
          activationRevision: null,
          enabled: false,
          status: 'disabled',
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(platformIdentityProviders.id, row.id),
            eq(platformIdentityProviders.status, 'pending_restart'),
            eq(platformIdentityProviders.activationRevision, row.activationRevision),
            eq(platformIdentityProviders.revision, row.activationRevision),
            eq(platformIdentityProviders.enabled, false),
          ),
        )
        .returning({ id: platformIdentityProviders.id });
      if (updated) reconciled.add(updated.id);
    }
    pendingPublished = pendingPublished.filter((provider) => !reconciled.has(provider.providerId));
  }
  return pendingPublished;
};
