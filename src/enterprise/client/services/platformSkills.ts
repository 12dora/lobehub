import { lambdaClient } from '@/libs/trpc/client';

/** Public, read-only boundary for the platform Published Skill Catalog. */
class PlatformSkillsService {
  getPublishedCatalog = () => lambdaClient.platform.skills.getPublishedCatalog.query();
}

export const platformSkillsService = new PlatformSkillsService();
