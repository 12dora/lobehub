import { lambdaClient } from '@/libs/trpc/client';
import type {
  UserSettingsGetEffectiveOutput,
  UserSettingsPatchOverrideInput,
  UserSettingsPatchOverrideOutput,
  UserSettingsResetOverrideInput,
  UserSettingsResetOverrideOutput,
} from '@/server/enterprise/contracts/userSettings';

class UserSettingsService {
  getEffective = async (): Promise<UserSettingsGetEffectiveOutput> => {
    return lambdaClient.user.getEffectiveSettings.query();
  };

  patchOverride = async (
    input: UserSettingsPatchOverrideInput,
  ): Promise<UserSettingsPatchOverrideOutput> => {
    return lambdaClient.user.patchSettingOverride.mutate(input);
  };

  resetOverride = async (
    input: UserSettingsResetOverrideInput,
  ): Promise<UserSettingsResetOverrideOutput> => {
    return lambdaClient.user.resetSettingOverride.mutate(input);
  };
}

export const userSettingsService = new UserSettingsService();
