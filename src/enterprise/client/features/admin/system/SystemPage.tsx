'use client';

import { useCallback, useMemo, useState } from 'react';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { deriveAdminSystemPermissions } from '@/enterprise/client/features/admin/system/controller';
import {
  useAdminSystemAuthSnapshotStatus,
  useAdminSystemInstances,
  useAdminSystemJobMutations,
  useAdminSystemJobs,
  useAdminSystemStatus,
} from '@/enterprise/client/features/admin/system/hooks/useAdminSystem';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';
import { adminSystemService } from '@/enterprise/client/services/adminSystem';

import { SystemPageView } from './SystemPageView';

const SystemPage = () => {
  const { authMethod, permissions, status: accessStatus } = useAdminAccess();
  const { canOperate, canRead } = deriveAdminSystemPermissions(permissions);
  const enabled = accessStatus === 'allowed' && canRead;
  const canReadAuthSnapshot = permissions.includes(PLATFORM_PERMISSIONS.OIDC_PUBLISH);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showOfflineInstances, setShowOfflineInstances] = useState(false);
  const status = useAdminSystemStatus(enabled, adminSystemService);
  const authSnapshot = useAdminSystemAuthSnapshotStatus(
    enabled && canReadAuthSnapshot,
    adminIdentityProvidersService.getAuthSnapshotStatus,
  );
  const instancesInput = useMemo(
    () => ({ limit: 50, state: showOfflineInstances ? ('all' as const) : ('live' as const) }),
    [showOfflineInstances],
  );
  const instances = useAdminSystemInstances(enabled, adminSystemService, instancesInput);
  const mutateStatus = status.mutate;
  const refreshInstances = instances.refresh;
  const refreshAuthority = useCallback(async () => {
    await mutateStatus();
  }, [mutateStatus]);
  const authoritativeActiveCount =
    status.data?.jobs.status === 'healthy' ? status.data.jobs.active : null;
  const jobs = useAdminSystemJobs(enabled, adminSystemService, {
    authoritativeActiveCount,
    refreshAuthority,
  });
  const mutations = useAdminSystemJobMutations({
    authMethod: authMethod ?? null,
    onRefresh: jobs.refresh,
    service: adminSystemService,
  });
  const refreshJobs = jobs.refresh;
  const retryCommittedRefresh = mutations.retryRefresh;
  const hasCommittedRefreshPending = mutations.refreshPendingJobIds.length > 0;
  const mutateAuthSnapshot = authSnapshot.mutate;

  const refreshAll = useCallback(async () => {
    if (!enabled) return;
    setIsRefreshing(true);
    try {
      const refreshRecentJobs = hasCommittedRefreshPending
        ? retryCommittedRefresh()
        : refreshJobs();
      await Promise.allSettled([
        mutateStatus(),
        ...(canReadAuthSnapshot ? [mutateAuthSnapshot()] : []),
        refreshInstances(),
        refreshRecentJobs,
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [
    canReadAuthSnapshot,
    enabled,
    hasCommittedRefreshPending,
    mutateAuthSnapshot,
    mutateStatus,
    refreshInstances,
    refreshJobs,
    retryCommittedRefresh,
  ]);

  return (
    <SystemPageView
      authSnapshot={authSnapshot.data}
      canOperate={canOperate}
      instances={instances}
      isRefreshing={isRefreshing}
      jobs={jobs}
      mutations={mutations}
      showOfflineInstances={showOfflineInstances}
      status={{
        data: status.data,
        error: status.error,
        isLoading: status.isLoading,
        retry: () => void status.mutate(),
      }}
      onRefresh={() => void refreshAll()}
      onShowOfflineInstancesChange={setShowOfflineInstances}
    />
  );
};

export default SystemPage;
