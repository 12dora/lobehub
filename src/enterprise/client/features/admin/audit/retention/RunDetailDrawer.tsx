'use client';

import { Alert, Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Drawer } from 'antd';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditRetentionRunItem } from '@/enterprise/client/services/adminAudit';

export interface RunDetailDrawerProps {
  canOperate: boolean;
  detail: AdminAuditRetentionRunItem | null;
  onClose: () => void;
  onRunDryCheck: () => void;
  retentionFailureMessage: (run: AdminAuditRetentionRunItem) => string;
}

const RunDetailDrawer = memo<RunDetailDrawerProps>(
  ({ canOperate, detail, onClose, onRunDryCheck, retentionFailureMessage }) => {
    const { t } = useTranslation('admin');

    return (
      <Drawer
        destroyOnClose
        open={Boolean(detail)}
        title={t('audit.retention.runs.detailTitle')}
        width={480}
        onClose={onClose}
      >
        {detail ? (
          <Flexbox gap={16}>
            {detail.status === 'failed' ? (
              <Alert
                showIcon
                description={retentionFailureMessage(detail)}
                message={t('audit.retention.runs.failureTitle')}
                type="error"
                action={
                  canOperate ? (
                    <Button size="small" onClick={onRunDryCheck}>
                      {t('audit.retention.runs.runDryCheck')}
                    </Button>
                  ) : null
                }
              />
            ) : null}
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{t('audit.retention.runs.countMetric')}</th>
                  <th style={{ textAlign: 'right' }}>{t('audit.retention.runs.scanned')}</th>
                  <th style={{ textAlign: 'right' }}>{t('audit.retention.runs.deleted')}</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['operationLogs', 'operationLogsScanned', 'operationLogsDeleted'],
                    ['conversations', 'conversationsScanned', 'conversationsDeleted'],
                    ['messages', 'messagesScanned', 'messagesDeleted'],
                    ['topics', 'topicsScanned', 'topicsDeleted'],
                    ['sessions', 'sessionsScanned', 'sessionsDeleted'],
                    ['exportArtifacts', 'exportArtifactsScanned', 'exportArtifactsDeleted'],
                  ] as const
                ).map(([label, scanned, deleted]) => (
                  <tr key={label}>
                    <td>{t(`audit.retention.runs.metric.${label}` as never)}</td>
                    <td style={{ textAlign: 'right' }}>{detail.counts[scanned] ?? 0}</td>
                    <td style={{ textAlign: 'right' }}>{detail.counts[deleted] ?? 0}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2}>{t('audit.retention.runs.skippedHoldLabel')}</td>
                  <td style={{ textAlign: 'right' }}>{detail.counts.skippedLegalHold ?? 0}</td>
                </tr>
              </tbody>
            </table>
          </Flexbox>
        ) : null}
      </Drawer>
    );
  },
);

export default RunDetailDrawer;
