import { authedProcedure, publicProcedure, router } from '@/libs/trpc/lambda';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { buildPlatformCapabilities } from '../services/platformCapabilities';
import { buildPlatformPublicSnapshot } from '../services/platformPublicSnapshot';

/**
 * Read-only platform router (M00).
 * Mounted on lambda root in PR-003. Does not perform mutations.
 *
 * - getCapabilities: **authenticated** principal only (M00 §8 / 02 清单「本人」).
 * - getPublicSnapshot: anonymous-safe branding / login flags.
 */
export const platformRouter = router({
  getCapabilities: authedProcedure.query(({ ctx }) => {
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
