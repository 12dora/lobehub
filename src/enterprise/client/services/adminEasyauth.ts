import { lambdaClient } from '@/libs/trpc/client';

class AdminEasyauthService {
  getStatus = () => lambdaClient.admin.easyauth.getStatus.query();
}

export const adminEasyauthService = new AdminEasyauthService();
