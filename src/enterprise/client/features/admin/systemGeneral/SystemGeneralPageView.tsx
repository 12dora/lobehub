'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Box, KeyRound, Mail } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { AdminLoadingSurface } from '@/enterprise/client/features/admin/pages/AdminStateSurfaces';
import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
import type {
  AdminSystemInfraSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';
import type { AdminSystemInfraDependency } from '@/server/enterprise/contracts/adminSystem';

import { InfraSettingsCard } from './InfraSettingsCard';
import { infraSettingsStyles as styles } from './styles';

const OBJECT_STORAGE_ENV = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_REGION',
  'S3_PUBLIC_DOMAIN',
  'S3_ENABLE_PATH_STYLE',
] as const;

const MAIL_ENV = [
  'EMAIL_SERVICE_PROVIDER',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'SMTP_SECURE',
  'RESEND_API_KEY',
  'RESEND_FROM',
] as const;

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

export const SystemGeneralPageView = memo<SystemGeneralPageViewProps>(
  ({ canOperate, data, error, isLoading, onRetry, onTest, probeBusy, probeResults }) => {
    const { t } = useTranslation('admin');
    const unset = (value: string | number | null) =>
      value === null ? t('systemGeneral.values.unset') : String(value);
    const yesNo = (value: boolean | null) =>
      value === null
        ? t('systemGeneral.values.unset')
        : t(value ? 'systemGeneral.values.yes' : 'systemGeneral.values.no');

    return (
      <AdminPageTemplate
        description={t('systemGeneral.description')}
        title={t('systemGeneral.title')}
      >
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
            <InfraSettingsCard
              canTest={canOperate}
              envVars={OBJECT_STORAGE_ENV}
              icon={Box}
              probe={probeResults.objectStorage}
              probing={Boolean(probeBusy.objectStorage)}
              status={data.objectStorage.status}
              title={t('systemGeneral.objectStorage.title')}
              fields={[
                {
                  label: t('systemGeneral.objectStorage.fields.endpoint'),
                  value: unset(data.objectStorage.endpoint),
                },
                {
                  label: t('systemGeneral.objectStorage.fields.region'),
                  value: unset(data.objectStorage.region),
                },
                {
                  label: t('systemGeneral.objectStorage.fields.bucket'),
                  value: unset(data.objectStorage.bucket),
                },
                {
                  label: t('systemGeneral.objectStorage.fields.accessKeyId'),
                  value: unset(data.objectStorage.accessId),
                },
                {
                  label: t('systemGeneral.objectStorage.fields.publicDomain'),
                  value: unset(data.objectStorage.publicDomain),
                },
                {
                  label: t('systemGeneral.objectStorage.fields.pathStyle'),
                  value: yesNo(data.objectStorage.pathStyle),
                },
              ]}
              onTest={() => onTest('objectStorage')}
            />
            <InfraSettingsCard
              canTest={canOperate}
              envVars={MAIL_ENV}
              icon={Mail}
              probe={probeResults.mail}
              probing={Boolean(probeBusy.mail)}
              status={data.mail.status}
              title={t('systemGeneral.mail.title')}
              fields={[
                {
                  label: t('systemGeneral.mail.fields.provider'),
                  value: t(`systemGeneral.mail.provider.${data.mail.provider}`),
                },
                {
                  label: t('systemGeneral.mail.fields.host'),
                  value: unset(data.mail.host),
                },
                {
                  label: t('systemGeneral.mail.fields.port'),
                  value: unset(data.mail.port),
                },
                {
                  label: t('systemGeneral.mail.fields.fromAddress'),
                  value: unset(data.mail.fromAddress),
                },
                {
                  label: t('systemGeneral.mail.fields.senderName'),
                  value: unset(data.mail.senderName),
                },
                {
                  label: t('systemGeneral.mail.fields.secure'),
                  value: yesNo(data.mail.secure),
                },
              ]}
              onTest={() => onTest('mail')}
            />
            <InfraSettingsCard
              canTest={canOperate}
              envVars={KEY_MANAGEMENT_ENV}
              icon={KeyRound}
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
      </AdminPageTemplate>
    );
  },
);

SystemGeneralPageView.displayName = 'AdminSystemGeneralPageView';
