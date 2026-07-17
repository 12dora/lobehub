import type { AgentPluginEntry } from '@lobechat/types';

import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { AgentModel } from '@/database/models/agent';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { signPlatformSkillOperationProof } from '@/libs/trpc/utils/internalJwt';

import {
  beginPlatformSkillOperationInputSchema,
  platformSkillOperationProofSchema,
  publishedSkillCatalogSchema,
} from '../contracts/skillCatalog';
import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { throwEnterpriseError } from '../guards/enterpriseErrors';
import { resolvePublishedManagedResourcePolicies } from '../services/managedResourceCapabilities';
import {
  getBuiltinSkillDefinitions,
  getEmptyPublishedSkillCatalog,
  hasExactPlatformSkillRefs,
  selectPlatformOperationSkills,
  SkillCatalogReadService,
} from '../services/skillCatalog';

const getPublishedCatalog = authedProcedure
  .use(serverDatabase)
  .output(publishedSkillCatalogSchema)
  .query(async ({ ctx }) => {
    const flags = parseEnterpriseFeatureFlags(process.env);
    if (!flags.ENABLE_PLATFORM_MANAGED_SKILLS) return getEmptyPublishedSkillCatalog();
    try {
      return await new SkillCatalogReadService(ctx.serverDB, {
        builtinSkills: getBuiltinSkillDefinitions(),
      }).getPublishedCatalog();
    } catch {
      return throwEnterpriseError({
        code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
        details: { issueCount: 1 },
        httpCode: 'PRECONDITION_FAILED',
      });
    }
  });

export const platformSkillsRouter = router({
  /** Freeze the current published refs into a short-lived, user/agent/operation-bound proof. */
  beginOperation: wsCompatProcedure
    .use(serverDatabase)
    .input(beginPlatformSkillOperationInputSchema)
    .output(platformSkillOperationProofSchema)
    .mutation(async ({ ctx, input }) => {
      const flags = parseEnterpriseFeatureFlags(process.env);
      const managed = await resolvePublishedManagedResourcePolicies({ db: ctx.serverDB, flags });
      if (!managed.publicCapabilities.skills) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
          details: { resource: 'skills' },
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      const catalog = await new SkillCatalogReadService(ctx.serverDB, {
        builtinSkills: getBuiltinSkillDefinitions(),
      }).getPublishedCatalog();
      const agent = await new AgentModel(
        ctx.serverDB,
        ctx.userId,
        ctx.workspaceId ?? undefined,
      ).getAgentConfigById(input.agentId);
      if (!agent) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          details: { issueCount: 1 },
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      const selected = selectPlatformOperationSkills(
        catalog.skills,
        agent.plugins as AgentPluginEntry[] | undefined,
      );
      const serverRefs = selected.map(({ skill: { checksum, skillKey, version } }) => ({
        checksum,
        skillKey,
        version,
      }));
      const exactCurrent =
        input.revision === catalog.revision && hasExactPlatformSkillRefs(input.refs, serverRefs);
      if (!exactCurrent) {
        return throwEnterpriseError({
          code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
          details: { issueCount: 1 },
          httpCode: 'PRECONDITION_FAILED',
        });
      }
      const scope = { ...input, refs: serverRefs };
      return {
        ...scope,
        proof: await signPlatformSkillOperationProof({ ...scope, userId: ctx.userId }),
      };
    }),
  /** Canonical public catalog name. */
  getPublishedCatalog,
  /** Compatibility alias retained for the PR040-A client. */
  getPublished: getPublishedCatalog,
});
