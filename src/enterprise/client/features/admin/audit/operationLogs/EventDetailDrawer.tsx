'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Drawer, Spin } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useFetchAuditEventDetail } from '../hooks/useAdminAudit';
import AuditStatusTag from '../shared/AuditStatusTag';
import {
  auditActionLabel,
  auditReasonLabel,
  auditTargetTypeLabel,
  formatAdminDateTime,
} from '../shared/format';
import JsonDiffView from '../shared/JsonDiffView';
import { toIsoOrUndefined } from '../shared/timeWindow';

const styles = createStaticStyles(({ css }) => ({
  label: css`
    color: ${cssVar.colorTextSecondary};
  `,
  row: css`
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 8px;
    align-items: start;
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-block-end: 20px;
  `,
}));

export interface EventDetailDrawerProps {
  eventId: string | null;
  filterWindow?: { from?: Date; to?: Date };
  onClose: () => void;
  open: boolean;
}

const Field = ({ label, children }: { children: React.ReactNode; label: string }) => (
  <div className={styles.row}>
    <Text className={styles.label}>{label}</Text>
    <div>{children}</div>
  </div>
);

const EventDetailDrawer = memo<EventDetailDrawerProps>(
  ({ eventId, open, onClose, filterWindow }) => {
    const { t } = useTranslation('admin');
    const navigate = useNavigate();
    const { data, isLoading, error } = useFetchAuditEventDetail(
      eventId ?? undefined,
      open && !!eventId,
    );

    const goExport = () => {
      if (!data) return;
      const params = new URLSearchParams();
      params.set('kind', 'operation_logs');
      params.set('create', '1');
      if (data.action) params.set('action', data.action);
      const from = toIsoOrUndefined(filterWindow?.from);
      const to = toIsoOrUndefined(filterWindow?.to);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (data.actorUserId) params.set('actorUserId', data.actorUserId);
      navigate(`/admin/audit/exports?${params.toString()}`);
      onClose();
    };

    return (
      <Drawer
        destroyOnClose
        open={open}
        title={t('audit.logs.detail.title')}
        width={Math.min(720, typeof window !== 'undefined' ? window.innerWidth - 48 : 720)}
        extra={
          data ? (
            <Button size="small" type="default" onClick={goExport}>
              {t('audit.logs.detail.createExport')}
            </Button>
          ) : null
        }
        onClose={onClose}
      >
        {isLoading && !data ? (
          <Flexbox align="center" justify="center" style={{ minHeight: 200 }}>
            <Spin />
          </Flexbox>
        ) : null}
        {error && !data ? <Text type="danger">{t('audit.logs.detail.loadError')}</Text> : null}
        {data ? (
          <>
            <div className={styles.section}>
              <Field label={t('audit.logs.columns.time')}>
                {formatAdminDateTime(data.createdAt)}
              </Field>
              <Field label={t('audit.logs.columns.action')}>
                {auditActionLabel(t, data.action)}
              </Field>
              <Field label={t('audit.logs.columns.actor')}>{data.actorUserId ?? '—'}</Field>
              <Field label={t('audit.logs.columns.result')}>
                <AuditStatusTag kind="result" value={data.result} />
              </Field>
              <Field label={t('audit.logs.columns.target')}>
                {auditTargetTypeLabel(t, data.targetType)}
              </Field>
              <Field label={t('audit.logs.columns.reason')}>
                {auditReasonLabel(t, data.reason) ?? '—'}
              </Field>
            </div>
            <div className={styles.section}>
              <Text style={{ fontWeight: 600 }}>{t('audit.logs.diff.title')}</Text>
              <JsonDiffView after={data.afterDiff} before={data.beforeDiff} />
            </div>
          </>
        ) : null}
      </Drawer>
    );
  },
);

EventDetailDrawer.displayName = 'AuditEventDetailDrawer';

export default EventDetailDrawer;
