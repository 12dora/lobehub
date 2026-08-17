import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminModulesGetOutput,
  AdminModulesRequestRestartOutput,
  AdminModulesUpdateInput,
  AdminModulesUpdateOutput,
} from '@/server/enterprise/contracts/adminModules';

/** Contract-derived client boundary for `admin.modules.*`. */
export type AdminModulesState = AdminModulesGetOutput;
export type AdminModuleSettingsSnapshot = AdminModulesState['snapshot'];

export interface AdminModulesService {
  get: () => Promise<AdminModulesState>;
  requestRestart: () => Promise<AdminModulesRequestRestartOutput>;
  update: (input: AdminModulesUpdateInput) => Promise<AdminModulesUpdateOutput>;
}

class AdminModulesServiceImpl implements AdminModulesService {
  get = () => lambdaClient.admin.modules.get.query();

  requestRestart = () => lambdaClient.admin.modules.requestRestart.mutate({});

  update = (input: AdminModulesUpdateInput) => lambdaClient.admin.modules.update.mutate(input);
}

export const adminModulesService: AdminModulesService = new AdminModulesServiceImpl();

/** Shared SWR key — the page, the setup guide and the disabled-route surface read one cache. */
export const ADMIN_MODULES_SWR_KEY = 'admin.modules.get';

export type { AdminModulesUpdateInput };
