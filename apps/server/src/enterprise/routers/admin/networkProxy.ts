/**
 * admin.networkProxy.* — platform network-proxy settings, subscriptions, engine, outlet.
 */
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { preAccessAuthedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';

import {
  adminNetworkProxyCreateSubscriptionInputSchema,
  adminNetworkProxyDeleteSubscriptionInputSchema,
  adminNetworkProxyDeleteSubscriptionOutputSchema,
  adminNetworkProxyGetArtifactStatusOutputSchema,
  adminNetworkProxyGetEngineLogsOutputSchema,
  adminNetworkProxyGetSettingsOutputSchema,
  adminNetworkProxyGetStatusOutputSchema,
  adminNetworkProxyInstallArtifactInputSchema,
  adminNetworkProxyInstallGeodataInputSchema,
  adminNetworkProxyInstallGeodataOutputSchema,
  adminNetworkProxyListNodesOutputSchema,
  adminNetworkProxyListSubscriptionsOutputSchema,
  adminNetworkProxyRefreshSubscriptionInputSchema,
  adminNetworkProxyRestartEngineInputSchema,
  adminNetworkProxySelectNodeInputSchema,
  adminNetworkProxySettingsMutationOutputSchema,
  adminNetworkProxyTestConnectivityInputSchema,
  adminNetworkProxyTestConnectivityOutputSchema,
  adminNetworkProxyTestLatencyInputSchema,
  adminNetworkProxyTestLatencyOutputSchema,
  adminNetworkProxyUpdateScopesInputSchema,
  adminNetworkProxyUpdateSettingsInputSchema,
  adminNetworkProxyUpdateSubscriptionInputSchema,
  subscriptionViewSchema,
} from '../../contracts/adminNetworkProxy';
import { withActiveUser } from '../../guards/activeUser';
import { withAdminMutationRateLimit } from '../../guards/adminMutationRateLimit';
import { withPlatformPermission } from '../../guards/platformPermission';
import {
  getEngineLogs,
  installArtifact,
  installGeodata,
  listNodes,
  restartEngine,
  selectNode,
  testLatency,
} from './networkProxy.engine';
import {
  getArtifactStatus,
  getSettings,
  getStatus,
  testConnectivity,
  updateScopes,
  updateSettings,
} from './networkProxy.settings';
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  refreshSubscription,
  updateSubscription,
} from './networkProxy.subscriptions';

const adminBase = preAccessAuthedProcedure
  .use(serverDatabase)
  .use(withActiveUser())
  .use(withAdminMutationRateLimit());

const networkProxyRead = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.NETWORK_PROXY_READ),
);
const networkProxyManage = adminBase.use(
  withPlatformPermission(PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE),
);

export const adminNetworkProxyRouter = router({
  createSubscription: networkProxyManage
    .input(adminNetworkProxyCreateSubscriptionInputSchema)
    .output(subscriptionViewSchema)
    .mutation(createSubscription),

  deleteSubscription: networkProxyManage
    .input(adminNetworkProxyDeleteSubscriptionInputSchema)
    .output(adminNetworkProxyDeleteSubscriptionOutputSchema)
    .mutation(deleteSubscription),

  getArtifactStatus: networkProxyRead
    .output(adminNetworkProxyGetArtifactStatusOutputSchema)
    .query(getArtifactStatus),

  getEngineLogs: networkProxyRead
    .output(adminNetworkProxyGetEngineLogsOutputSchema)
    .query(getEngineLogs),

  getSettings: networkProxyRead.output(adminNetworkProxyGetSettingsOutputSchema).query(getSettings),

  getStatus: networkProxyRead.output(adminNetworkProxyGetStatusOutputSchema).query(getStatus),

  installArtifact: networkProxyManage
    .input(adminNetworkProxyInstallArtifactInputSchema)
    .output(adminNetworkProxySettingsMutationOutputSchema)
    .mutation(installArtifact),

  installGeodata: networkProxyManage
    .input(adminNetworkProxyInstallGeodataInputSchema)
    .output(adminNetworkProxyInstallGeodataOutputSchema)
    .mutation(installGeodata),

  listNodes: networkProxyRead.output(adminNetworkProxyListNodesOutputSchema).query(listNodes),

  listSubscriptions: networkProxyRead
    .output(adminNetworkProxyListSubscriptionsOutputSchema)
    .query(listSubscriptions),

  refreshSubscription: networkProxyManage
    .input(adminNetworkProxyRefreshSubscriptionInputSchema)
    .output(subscriptionViewSchema)
    .mutation(refreshSubscription),

  restartEngine: networkProxyManage
    .input(adminNetworkProxyRestartEngineInputSchema)
    .output(adminNetworkProxySettingsMutationOutputSchema)
    .mutation(restartEngine),

  selectNode: networkProxyManage
    .input(adminNetworkProxySelectNodeInputSchema)
    .output(adminNetworkProxySettingsMutationOutputSchema)
    .mutation(selectNode),

  testConnectivity: networkProxyManage
    .input(adminNetworkProxyTestConnectivityInputSchema)
    .output(adminNetworkProxyTestConnectivityOutputSchema)
    .mutation(testConnectivity),

  testLatency: networkProxyManage
    .input(adminNetworkProxyTestLatencyInputSchema)
    .output(adminNetworkProxyTestLatencyOutputSchema)
    .mutation(testLatency),

  updateScopes: networkProxyManage
    .input(adminNetworkProxyUpdateScopesInputSchema)
    .output(adminNetworkProxyGetSettingsOutputSchema)
    .mutation(updateScopes),

  updateSettings: networkProxyManage
    .input(adminNetworkProxyUpdateSettingsInputSchema)
    .output(adminNetworkProxyGetSettingsOutputSchema)
    .mutation(updateSettings),

  updateSubscription: networkProxyManage
    .input(adminNetworkProxyUpdateSubscriptionInputSchema)
    .output(subscriptionViewSchema)
    .mutation(updateSubscription),
});
