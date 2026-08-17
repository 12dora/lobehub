'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { AdminLoadingSurface } from '@/enterprise/client/features/admin/pages/AdminStateSurfaces';
import type {
  AdminSystemInfraSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';
import type { AdminSystemInfraDependency } from '@/server/enterprise/contracts/adminSystem';

import { MailCard } from './infra/MailCard';
import { ObjectStorageCard } from './infra/ObjectStorageCard';
import { infraSettingsStyles as styles } from './styles';

export interface SystemGeneralPageViewProps {
  canOperate: boolean;
  data?: AdminSystemInfraSettings;
  error: unknown;
  isLoading: boolean;
  onRetry: () => void;
  onTest: (dependency: AdminSystemInfraDependency) => void;
  probeBusy: Partial<Record<AdminSystemInfraDependency, boolean>>;
  probeResults: Partial<Record<AdminSystemInfraDependency, AdminSystemTestDependencyResult>>;
}

/**
 * 基础设施 tab body — object storage and mail service.
 *
 * Both dependencies can be taken over from the environment and edited here. The encryption key
 * is deliberately absent: it decrypts everything else, so it must exist before any database read
 * and can never be configured from the admin panel — its health is reported on the 系统 status
 * page instead.
 *
 * The page chrome (title, tabs) lives in `SystemGeneralPage`; this component is only the body of
 * one tab so the 网络代理 tab can share the same shell.
 */
export const SystemGeneralPageView = memo<SystemGeneralPageViewProps>(
  ({ canOperate, data, error, isLoading, onRetry, onTest, probeBusy, probeResults }) => {
    const { t } = useTranslation('admin');

    return (
      <>
        {error && !data ? (
          <Alert
            showIcon
            description={t('systemGeneral.loadFailedDescription')}
            message={t('systemGeneral.loadFailed')}
            type="error"
            action={
              <Button size="small" type="primary" onClick={onRetry}>
                {t('systemGeneral.retry')}
              </Button>
            }
          />
        ) : isLoading && !data ? (
          <AdminLoadingSurface />
        ) : data ? (
          <div className={styles.grid}>
            <ObjectStorageCard
              canOperate={canOperate}
              probe={probeResults.objectStorage}
              probing={Boolean(probeBusy.objectStorage)}
              view={data.objectStorage}
              onTest={() => onTest('objectStorage')}
            />
            <MailCard
              canOperate={canOperate}
              probe={probeResults.mail}
              probing={Boolean(probeBusy.mail)}
              view={data.mail}
              onTest={() => onTest('mail')}
            />
          </div>
        ) : null}
      </>
    );
  },
);

SystemGeneralPageView.displayName = 'AdminSystemGeneralPageView';
