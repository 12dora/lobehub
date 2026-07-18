import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  platformAgentEffectiveGetInputSchema,
  platformAgentEffectiveGetOutputSchema,
  platformAgentEffectiveListOutputSchema,
  platformAgentSetHiddenInputSchema,
  platformAgentSetHiddenOutputSchema,
} from '../contracts/platformAgents';
import { withActiveUser } from '../guards/activeUser';
import { PlatformAgentEffectiveResolver } from '../services/agentCatalog';
import { mapAgentServiceError } from './admin/agentsSupport';

// User-facing platform.agents is mounted regardless of ENABLE_PLATFORM_ADMIN and can be
// activated via ENABLE_PLATFORM_MANAGED_AGENTS alone, so active-user enforcement must never
// depend on the admin flag — reject inactive/banned/epoch-invalid principals before any
// resolver/DB access.
const platformAgentBase = authedProcedure
  .use(serverDatabase)
  .use(withActiveUser({ enforceWhenAdminDisabled: true }));

export const platformAgentsRouter = router({
  getEffectiveAgent: platformAgentBase
    .input(platformAgentEffectiveGetInputSchema)
    .output(platformAgentEffectiveGetOutputSchema)
    .query(async ({ ctx, input }) =>
      new PlatformAgentEffectiveResolver(ctx.serverDB).getEffectiveAgent(
        ctx.userId!,
        input.platformAgentId,
      ),
    ),

  getEffectiveList: platformAgentBase
    .output(platformAgentEffectiveListOutputSchema)
    .query(async ({ ctx }) =>
      new PlatformAgentEffectiveResolver(ctx.serverDB).getEffectiveList(ctx.userId!),
    ),

  // Owner-scoped visibility toggle (M10 PR-049 · ROOT-01). Active-user enforced via
  // platformAgentBase. Mandatory Agents cannot be hidden (rejected in the resolver); default /
  // optional can. Toggling never materializes a local Agent. Errors are stable and redacted.
  setHidden: platformAgentBase
    .input(platformAgentSetHiddenInputSchema)
    .output(platformAgentSetHiddenOutputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await new PlatformAgentEffectiveResolver(ctx.serverDB).setAgentHidden(
          ctx.userId!,
          input.platformAgentId,
          input.hidden,
        );
        return { success: true as const };
      } catch (error) {
        return mapAgentServiceError(error);
      }
    }),
});
