import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminSidebarLayoutGetOutput,
  AdminSidebarLayoutUpdateInput,
  AdminSidebarLayoutUpdateOutput,
} from '@/server/enterprise/contracts/adminSidebarLayout';

/** Typed client boundary for `admin.sidebarLayout.*`. */
class AdminSidebarLayoutService {
  get = async (): Promise<AdminSidebarLayoutGetOutput> => {
    return lambdaClient.admin.sidebarLayout.get.query();
  };

  update = async (
    input: AdminSidebarLayoutUpdateInput,
  ): Promise<AdminSidebarLayoutUpdateOutput> => {
    return lambdaClient.admin.sidebarLayout.update.mutate(input);
  };
}

export const adminSidebarLayoutService = new AdminSidebarLayoutService();
