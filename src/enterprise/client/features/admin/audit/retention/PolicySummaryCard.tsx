'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Descriptions } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditPolicy } from '@/enterprise/client/services/adminAudit';

import { formatAdminDateTime } from '../shared/format';
import { CONTENT_ACCESS_MODE_KEYS } from './policyBounds';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
}));

export interface PolicySummaryCardProps {
  canUpdatePolicy: boolean;
  error: unknown;
  onEdit: () => void;
  onRetry: () => void;
  policy?: AdminAuditPolicy;
}

const PolicySummaryCard = memo<PolicySummaryCardProps>(
  ({ canUpdatePolicy, error, onEdit, onRetry, policy: p }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.card}>
        <Flexbox horizontal align="center" justify="space-between" style={{ marginBlockEnd: 12 }}>
          <Text style={{ fontWeight: 600 }}>{t('audit.retention.policy.title')}</Text>
          {canUpdatePolicy ? (
            <Button size="small" type="default" onClick={onEdit}>
              {t('audit.retention.policy.edit')}
            </Button>
          ) : null}
        </Flexbox>
        {error && !p ? (
          <Flexbox align="flex-start" gap={8}>
            <Text role="alert" type="danger">
              {t('audit.retention.policy.loadError')}
            </Text>
            <Button size="small" type="default" onClick={onRetry}>
              {t('primitives.dataTable.retry')}
            </Button>
          </Flexbox>
        ) : p ? (
          <Descriptions column={2} size="small">
            <Descriptions.Item label={t('audit.retention.policy.contentAccessMode')}>
              {t(CONTENT_ACCESS_MODE_KEYS[p.contentAccessMode])}
            </Descriptions.Item>
            <Descriptions.Item label={t('audit.retention.policy.redactionProfile')}>
              {t(`audit.retention.redaction.${p.redactionProfile}` as never, {
                defaultValue: p.redactionProfile,
              })}
            </Descriptions.Item>
            <Descriptions.Item label={t('audit.retention.policy.conversationDays')}>
              {p.conversationRetentionDays}
            </Descriptions.Item>
            <Descriptions.Item label={t('audit.retention.policy.operationLogDays')}>
              {p.operationLogRetentionDays}
            </Descriptions.Item>
            <Descriptions.Item label={t('audit.retention.policy.exportArtifactDays')}>
              {p.exportArtifactRetentionDays}
            </Descriptions.Item>
            <Descriptions.Item label={t('audit.retention.policy.maxListWindowDays')}>
              {p.maxListWindowDays}
            </Descriptions.Item>
            <Descriptions.Item label={t('audit.retention.policy.maxExportRows')}>
              {p.maxExportRows}
            </Descriptions.Item>
            <Descriptions.Item label={t('audit.retention.policy.messageBodyInExport')}>
              {p.messageBodyInExport ? t('audit.shared.yes') : t('audit.shared.no')}
            </Descriptions.Item>
            <Descriptions.Item label={t('audit.retention.policy.updatedBy')}>
              {p.updatedBy ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label={t('audit.retention.policy.updatedAt')}>
              {formatAdminDateTime(p.updatedAt)}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Text type="secondary">{t('primitives.dataTable.loading')}</Text>
        )}
      </div>
    );
  },
);

export default PolicySummaryCard;
