'use client';

import { memo } from 'react';

import { deriveAdminSystemPermissions } from '@/enterprise/client/features/admin/system/controller';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminSystemService } from '@/enterprise/client/services/adminSystem';

import { useAdminInfraSettings, useInfraDependencyProbe } from './hooks';
import { SystemGeneralPageView } from './SystemGeneralPageView';

const SystemGeneralPage = memo(() => {
  const { permissions, status: accessStatus } = useAdminAccess();
  const { canOperate, canRead } = deriveAdminSystemPermissions(permissions);
  const enabled = accessStatus === 'allowed' && canRead;
  const settings = useAdminInfraSettings(enabled, adminSystemService);
  const probe = useInfraDependencyProbe(adminSystemService);

  return (
    <SystemGeneralPageView
      canOperate={canOperate}
      data={settings.data}
      error={settings.error}
      isLoading={settings.isLoading}
      probeBusy={probe.busy}
      probeResults={probe.results}
      onRetry={() => void settings.mutate()}
      onTest={(dependency) => void probe.run(dependency)}
    />
  );
});

SystemGeneralPage.displayName = 'SystemGeneralPage';

export default SystemGeneralPage;
