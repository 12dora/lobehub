import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import { publishedSkillCatalogSchema } from '../contracts/skillCatalog';
import { parseEnterpriseFeatureFlags } from '../featureFlags';
import { throwEnterpriseError } from '../guards/enterpriseErrors';
import {
  getBuiltinSkillDefinitions,
  getEmptyPublishedSkillCatalog,
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
  /** Canonical public catalog name. */
  getPublishedCatalog,
  /** Compatibility alias retained for the PR040-A client. */
  getPublished: getPublishedCatalog,
});
