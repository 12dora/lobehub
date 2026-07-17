import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  platformAgentEffectiveGetInputSchema,
  platformAgentEffectiveGetOutputSchema,
  platformAgentEffectiveListOutputSchema,
} from '../contracts/platformAgents';
import { withActiveUser } from '../guards/activeUser';
import { PlatformAgentEffectiveResolver } from '../services/agentCatalog';

const platformAgentBase = authedProcedure.use(serverDatabase).use(withActiveUser());

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
});
