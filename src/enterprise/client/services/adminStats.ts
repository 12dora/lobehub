import { lambdaClient } from '@/libs/trpc/client';

type CountDateParams = {
  endDate?: string;
  range?: [string, string];
  startDate?: string;
};

/** Typed client boundary for platform-wide admin data statistics. */
class AdminStatsService {
  countAgents = async (params?: CountDateParams) =>
    lambdaClient.admin.stats.countAgents.query(params);

  countMessages = async (params?: CountDateParams) =>
    lambdaClient.admin.stats.countMessages.query(params);

  countTopics = async (params?: CountDateParams) =>
    lambdaClient.admin.stats.countTopics.query(params);

  getHeatmaps = async () => lambdaClient.admin.stats.getHeatmaps.query();

  getMaxTaskDuration = async () => lambdaClient.admin.stats.getMaxTaskDuration.query();

  getTokenHeatmaps = async () => lambdaClient.admin.stats.getTokenHeatmaps.query();

  rankAgents = async (limit?: number) => lambdaClient.admin.stats.rankAgents.query({ limit });

  /** Uses server default limit (10) — matches personal messageService.rankModels(). */
  rankModels = async () => lambdaClient.admin.stats.rankModels.query();

  rankTopics = async (limit?: number) => lambdaClient.admin.stats.rankTopics.query({ limit });

  totals = async (activeDays?: number) => lambdaClient.admin.stats.totals.query({ activeDays });

  usageFindAndGroupByDay = async (mo?: string) =>
    lambdaClient.admin.stats.usageFindAndGroupByDay.query({ mo });

  usageFindByMonth = async (mo?: string) => lambdaClient.admin.stats.usageFindByMonth.query({ mo });
}

export const adminStatsService = new AdminStatsService();
