import { Plans } from '@lobechat/types';

import { getReferralStatus, getSubscriptionPlan } from '@/business/server/user';
import type { UserModel } from '@/database/models/user';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';

import { isModuleEnabled } from '../moduleSettings';

/**
 * Page-load user state: 1 SQL for user+settings+onboarding probes.
 * Referral / subscription stay no-ops in OSS; skip them when `market` is off.
 */
export const loadGetUserStateBundle = async (params: { userId: string; userModel: UserModel }) => {
  const marketOn = await isModuleEnabled('market').catch(() => true);

  const [bundle, referralStatus, subscriptionPlan] = await Promise.all([
    params.userModel.getUserStateBundle(KeyVaultsGateKeeper.getUserKeyVaults),
    marketOn ? getReferralStatus(params.userId) : Promise.resolve(undefined),
    marketOn ? getSubscriptionPlan(params.userId) : Promise.resolve(Plans.Free),
  ]);

  return {
    hasExtraSession: bundle.hasExtraSession,
    messageCount: bundle.messageCount,
    referralStatus,
    state: bundle.state,
    subscriptionPlan,
  };
};
