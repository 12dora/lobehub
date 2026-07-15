import { publicProcedure, router } from '@/libs/trpc/lambda';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { buildPlatformCapabilities } from '../services/platformCapabilities';
import { buildPlatformPublicSnapshot } from '../services/platformPublicSnapshot';

/**
 * Read-only platform router (M00).
 * Mounted on lambda root in PR-003. Does not perform mutations.
 *
 * - getCapabilities: public surface for current principal (adminAccess needs M02 RBAC).
 * - getPublicSnapshot: anonymous-safe branding / login flags.
 */
export const platformRouter = router({
  getCapabilities: publicProcedure.query(({ ctx }) => {
    const flags = parseEnterpriseFeatureFlags(process.env);

    // M00: no platform RBAC yet — never grant adminAccess from client-only signals.
    // M02 will resolve adminAccess from Global RBAC for ctx.userId.
    void ctx.userId;

    return buildPlatformCapabilities({
      adminAccess: false,
      flags,
    });
  }),

  getPublicSnapshot: publicProcedure.query(() => {
    const flags = parseEnterpriseFeatureFlags(process.env);

    // Branding / IdP payloads come from M11/M12 publishers; empty until then.
    return buildPlatformPublicSnapshot({
      flags,
      workAccountEnabled: false,
    });
  }),
});

export type PlatformRouter = typeof platformRouter;
