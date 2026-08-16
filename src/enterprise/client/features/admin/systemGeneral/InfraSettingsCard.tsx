'use client';

import { Flexbox, Icon, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminSystemTestDependencyResult } from '@/enterprise/client/services/adminSystem';

import { infraSettingsStyles as styles } from './styles';

interface Field {
  label: string;
  value: ReactNode;
}

export interface InfraSettingsCardProps {
  canTest: boolean;
  envVars: readonly string[];
  fields: readonly Field[];
  icon: LucideIcon;
  onTest: () => void;
  probe?: AdminSystemTestDependencyResult;
  probing: boolean;
  status: string;
  title: string;
}

const display = (value: ReactNode): ReactNode => value ?? '—';

/**
 * Settings-card reading of the shared dependency status: a passive-only check ("unknown" on the
 * health page) simply means the dependency is configured but not yet verified — say so instead
 * of "未知", and offer 测试连接 for the verification.
 */
const STATUS_PRESENTATION: Record<
  string,
  { icon: LucideIcon; key: string; tone: 'default' | 'error' | 'success' | 'warning' }
> = {
  degraded: { icon: AlertTriangle, key: 'incomplete', tone: 'warning' },
  disabled: { icon: CircleDashed, key: 'notConfigured', tone: 'default' },
  healthy: { icon: CheckCircle2, key: 'healthy', tone: 'success' },
  unavailable: { icon: XCircle, key: 'unavailable', tone: 'error' },
  unknown: { icon: CheckCircle2, key: 'configured', tone: 'default' },
};

const InfraStatusTag = memo<{ status: string }>(({ status }) => {
  const { t } = useTranslation('admin');
  const p = STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.unknown!;
  return (
    <Tag color={p.tone} icon={<Icon icon={p.icon} size={12} />} size="small">
      {t(`systemGeneral.status.${p.key}` as never)}
    </Tag>
  );
});

export const InfraSettingsCard = memo<InfraSettingsCardProps>(
  ({ canTest, envVars, fields, icon, onTest, probe, probing, status, title }) => {
    const { t } = useTranslation('admin');

    return (
      <section className={styles.card}>
        <div className={styles.header}>
          <div className={styles.title}>
            <Icon icon={icon} size={16} />
            <Text strong>{title}</Text>
          </div>
          <InfraStatusTag status={status} />
        </div>

        <div className={styles.cardBody}>
          <div className={styles.fields}>
            {fields.map((field) => (
              <div className={styles.fieldRow} key={field.label}>
                <Text className={styles.fieldLabel} type="secondary">
                  {field.label}
                </Text>
                <Text className={styles.fieldValue}>{display(field.value)}</Text>
              </div>
            ))}
          </div>

          <div className={styles.footer}>
            {probe ? (
              <Flexbox gap={4}>
                <Text
                  type={
                    !probe.ok
                      ? 'danger'
                      : probe.message === 'configured_unverified'
                        ? 'secondary'
                        : 'success'
                  }
                >
                  {t(
                    !probe.ok
                      ? 'systemGeneral.test.failure'
                      : probe.message === 'configured_unverified'
                        ? 'systemGeneral.test.unverified'
                        : 'systemGeneral.test.success',
                  )}
                  {probe.message
                    ? ` · ${t(`systemGeneral.test.reason.${probe.message}` as never)}`
                    : ''}
                </Text>
                <Text className={styles.code} type="secondary">
                  {t('systemGeneral.test.latency', { ms: probe.latencyMs })}
                </Text>
              </Flexbox>
            ) : null}

            {canTest ? (
              <div>
                <Button loading={probing} size="small" onClick={onTest}>
                  {t('systemGeneral.testConnection')}
                </Button>
              </div>
            ) : null}

            <div className={styles.hint}>
              <Text type="secondary">{t('systemGeneral.howToChange.title')}</Text>
              <div className={styles.envList}>
                {envVars.map((name) => (
                  <span className={styles.envChip} key={name}>
                    {name}
                  </span>
                ))}
              </div>
              <Text type="secondary">{t('systemGeneral.howToChange.restart')}</Text>
            </div>
          </div>
        </div>
      </section>
    );
  },
);

InfraSettingsCard.displayName = 'AdminInfraSettingsCard';
