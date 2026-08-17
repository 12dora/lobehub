import {
  type AdminInfraSettingsService,
  adminSystemService,
} from '@/enterprise/client/services/adminSystem';

/**
 * The write half of the infrastructure service. Narrowed to what the editor needs so tests can
 * inject a stub without standing up the whole client service.
 */
export type InfraSettingsMutationService = Pick<
  AdminInfraSettingsService,
  'testDependency' | 'updateInfraSettings'
>;

export const infraSettingsMutationService: InfraSettingsMutationService = adminSystemService;
