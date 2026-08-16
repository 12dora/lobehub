import { lambdaClient } from '@/libs/trpc/client';
import type {
  ContentModerationOverview,
  ContentModerationRecordListInput,
  ContentModerationRecordListOutput,
  ContentModerationSettingsUpdateInput,
  ContentModerationStatsInput,
  ContentModerationStatsOutput,
  ContentModerationTestClassifierInput,
  ContentModerationTestClassifierOutput,
} from '@/types/platform/contentModeration';

import {
  type ModerationRecordDetail,
  type ModerationSettingsBundle,
  normalizeModerationSettingsResponse,
} from './types';

/**
 * Typed client boundary for `admin.contentModeration.*`.
 *
 * Kept inside the feature folder (rather than `client/services/`) because it is the only
 * consumer; the shape tolerance for `getSettings` lives in `types.ts` so a server-side
 * wrapper change cannot blank the settings tab.
 */
export class AdminContentModerationService {
  getSettings = async (): Promise<ModerationSettingsBundle> => {
    const raw = await lambdaClient.admin.contentModeration.getSettings.query();
    return normalizeModerationSettingsResponse(raw);
  };

  getOverview = async (): Promise<ContentModerationOverview> => {
    return lambdaClient.admin.contentModeration.getOverview.query();
  };

  getStats = async (input: ContentModerationStatsInput): Promise<ContentModerationStatsOutput> => {
    return lambdaClient.admin.contentModeration.getStats.query(input);
  };

  listRecords = async (
    input: ContentModerationRecordListInput,
  ): Promise<ContentModerationRecordListOutput> => {
    return lambdaClient.admin.contentModeration.listRecords.query(input);
  };

  getRecord = async (input: { id: string }): Promise<ModerationRecordDetail> => {
    return lambdaClient.admin.contentModeration.getRecord.query(input);
  };

  updateSettings = async (
    input: ContentModerationSettingsUpdateInput,
  ): Promise<ModerationSettingsBundle> => {
    const raw = await lambdaClient.admin.contentModeration.updateSettings.mutate(input);
    return normalizeModerationSettingsResponse(raw);
  };

  testClassifier = async (
    input: ContentModerationTestClassifierInput,
  ): Promise<ContentModerationTestClassifierOutput> => {
    return lambdaClient.admin.contentModeration.testClassifier.mutate(input);
  };

  revealRecordPrompt = async (input: { id: string }): Promise<{ prompt: string | null }> => {
    return lambdaClient.admin.contentModeration.revealRecordPrompt.mutate(input);
  };

  deleteRecords = async (input: { ids: string[] }): Promise<{ deleted: number }> => {
    return lambdaClient.admin.contentModeration.deleteRecords.mutate(input);
  };

  clearDecisionCache = async (): Promise<{ deleted: number }> => {
    return lambdaClient.admin.contentModeration.clearDecisionCache.mutate();
  };
}

export const adminContentModerationService = new AdminContentModerationService();
