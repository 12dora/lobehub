'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { KeyRound } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { AdminLoadingSurface } from '@/enterprise/client/features/admin/pages/AdminStateSurfaces';
import type {
  AdminSystemInfraSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';
import type { AdminSystemInfraDependency } from '@/server/enterprise/contracts/adminSystem';

import { useInfraValueFormatters } from './infra/format';
import { MailCard } from './infra/MailCard';
import { ObjectStorageCard } from './infra/ObjectStorageCard';
import { InfraSettingsCard } from './InfraSettingsCard';
import { infraSettingsStyles as styles } from './styles';

const KEY_MANAGEMENT_ENV = [
  'PLATFORM_MASTER_KEY',
  'PLATFORM_MASTER_KEY_ID',
  'PLATFORM_KEY_PROVIDER',
  'VAULT_ADDR',
  'VAULT_TOKEN',
  'VAULT_APPROLE_ROLE_ID',
  'VAULT_APPROLE_SECRET_ID',
  'VAULT_APPROLE_MOUNT_PATH',
  'VAULT_KV_MOUNT_PATH',
  'VAULT_KV_SECRET_PATH',
] as const;

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
 * 基础设施 tab body — object storage / mail / secret management.
 *
 * Object storage and mail can be taken over from the environment and edited here; secret
 * management cannot (the master key decrypts everything else, so it has to exist before any
 * database read) and stays a status card.
 *
 * The page chrome (title, tabs) lives in `SystemGeneralPage`; this component is only the body of
 * one tab so the 网络代理 tab can share the same shell.
 */
export const SystemGeneralPageView = memo<SystemGeneralPageViewProps>(
  ({ canOperate, data, error, isLoading, onRetry, onTest, probeBusy, probeResults }) => {
    const { t } = useTranslation('admin');
    const { unset, yesNo } = useInfraValueFormatters();

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
            <InfraSettingsCard
              canTest={canOperate}
              envVars={KEY_MANAGEMENT_ENV}
              icon={KeyRound}
              notice={t('systemGeneral.keyManagement.readOnlyNotice')}
              probe={probeResults.keyManagement}
              probing={Boolean(probeBusy.keyManagement)}
              status={data.keyManagement.status}
              title={t('systemGeneral.keyManagement.title')}
              fields={[
                {
                  label: t('systemGeneral.keyManagement.fields.provider'),
                  value: t(`systemGeneral.keyManagement.provider.${data.keyManagement.provider}`),
                },
                {
                  label: t('systemGeneral.keyManagement.fields.masterKeyConfigured'),
                  value: yesNo(data.keyManagement.masterKeyConfigured),
                },
                {
                  label: t('systemGeneral.keyManagement.fields.keyId'),
                  value: unset(data.keyManagement.keyId),
                },
                {
                  label: t('systemGeneral.keyManagement.fields.vaultAddress'),
                  value: unset(data.keyManagement.vaultAddress),
                },
              ]}
              onTest={() => onTest('keyManagement')}
            />
          </div>
        ) : null}
      </>
    );
  },
);

SystemGeneralPageView.displayName = 'AdminSystemGeneralPageView';
