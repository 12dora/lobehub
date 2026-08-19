'use client';

import { Flexbox, Input, Text } from '@lobehub/ui';
import { Button, Modal, Switch } from '@lobehub/ui/base-ui';
import { DatePicker } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import dayjs from 'dayjs';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { AdminAuditExportsCreateInput } from '@/enterprise/client/services/adminAudit';

import { useFetchAuditPolicy } from '../hooks/useAdminAudit';
import AuditUserSearchSelect from '../shared/AuditUserSearchSelect';
import { hasPermission } from '../shared/format';
import { openAuditReasonModal } from '../shared/openAuditReasonModal';
import { getDefaultAuditTimeWindow } from '../shared/timeWindow';
import type { ExportKind } from './exportCreateForm';
import {
  buildExportCreateInput,
  canAdvanceFromFilters,
  exportBodyAllowed,
  parseExportPrefill,
} from './exportCreateForm';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    cursor: pointer;

    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    align-items: flex-start;
    justify-content: flex-start;

    min-width: 140px;
    padding: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    text-align: start;

    &[data-active='true'] {
      border-color: ${cssVar.colorPrimary};
      box-shadow: 0 0 0 1px ${cssVar.colorPrimary};
    }
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-block-end: 12px;
  `,
  step: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
}));

export interface CreateExportModalProps {
  authMethod?: AdminReauthAuthMethod | null;
  onClose: () => void;
  onCreated: () => void;
  onSubmit: (input: AdminAuditExportsCreateInput) => Promise<unknown>;
  open: boolean;
  searchParams?: URLSearchParams;
}

const CreateExportModal = memo<CreateExportModalProps>(
  ({ open, onClose, onCreated, onSubmit, authMethod, searchParams }) => {
    const { t } = useTranslation('admin');
    const { permissions } = useAdminAccess();
    const canReadPolicy = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_READ);
    const canSearchUsers = canReadPolicy;
    // policy.get requires AUDIT_READ — never fetch without it.
    const policy = useFetchAuditPolicy(open && canReadPolicy);
    const [draft, setDraft] = useState(() =>
      parseExportPrefill(undefined, getDefaultAuditTimeWindow()),
    );
    const { action, actorUserId, includeBodies, kind, q, range, step, topicId, userId } = draft;

    // Reset every field when a new modal session starts, then apply URL prefill
    // as a complete replacement so reopen never reuses stale filters.
    useEffect(() => {
      if (!open) return;
      setDraft(parseExportPrefill(searchParams, getDefaultAuditTimeWindow()));
    }, [open, searchParams]);

    // Conservative: without policy read, never enable includeMessageBodies.
    const bodyAllowed = exportBodyAllowed(canReadPolicy, policy.data);

    const canNextFromFilters = () => canAdvanceFromFilters(kind, range, userId);

    const kindLabel = (k: ExportKind) => {
      switch (k) {
        case 'operation_logs': {
          return t('audit.exports.kind.operation_logs');
        }
        case 'conversations': {
          return t('audit.exports.kind.conversations');
        }
        case 'user_timeline': {
          return t('audit.exports.kind.user_timeline');
        }
        default: {
          return k;
        }
      }
    };

    const submitWithReason = () => {
      openAuditReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => buildExportCreateInput(draft, reason, bodyAllowed),
        description: t('audit.exports.create.reasonDesc'),
        onSubmit: async (payload) => {
          await onSubmit(payload as AdminAuditExportsCreateInput);
          onCreated();
          onClose();
        },
        submitLabel: t('audit.exports.create.submit'),
        targetLabel: kindLabel(kind),
        title: t('audit.exports.create.title'),
      });
    };

    return (
      <Modal
        open={open}
        title={t('audit.exports.create.title')}
        footer={
          <Flexbox horizontal gap={8} justify="flex-end">
            <Button type="default" onClick={onClose}>
              {t('users.modals.cancel')}
            </Button>
            {step > 0 ? (
              <Button type="default" onClick={() => setDraft((d) => ({ ...d, step: d.step - 1 }))}>
                {t('audit.exports.create.back')}
              </Button>
            ) : null}
            {step < 1 ? (
              <Button type="primary" onClick={() => setDraft((d) => ({ ...d, step: 1 }))}>
                {t('audit.exports.create.next')}
              </Button>
            ) : (
              <Button disabled={!canNextFromFilters()} type="primary" onClick={submitWithReason}>
                {t('audit.exports.create.continueReason')}
              </Button>
            )}
          </Flexbox>
        }
        onCancel={onClose}
      >
        {step === 0 ? (
          <div className={styles.step}>
            <Text type="secondary">{t('audit.exports.create.pickKind')}</Text>
            <Flexbox horizontal gap={10} style={{ flexWrap: 'wrap' }}>
              {(['operation_logs', 'conversations', 'user_timeline'] as const).map((k) => (
                <button
                  className={styles.card}
                  data-active={kind === k}
                  key={k}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, kind: k }))}
                >
                  <Text style={{ fontWeight: 600, margin: 0 }}>
                    {t(`audit.exports.kind.${k}` as never)}
                  </Text>
                  <Text style={{ fontSize: 12 }} type="secondary">
                    {t(`audit.exports.kindDesc.${k}` as never)}
                  </Text>
                </button>
              ))}
            </Flexbox>
          </div>
        ) : (
          <div className={styles.step}>
            <div className={styles.field}>
              <Text>{t('audit.exports.create.timeRange')}</Text>
              <DatePicker.RangePicker
                showTime
                allowClear={false}
                placeholder={[t('timeRange.from'), t('timeRange.to')]}
                style={{ width: '100%' }}
                value={[dayjs(range[0]), dayjs(range[1])]}
                onChange={(vals) => {
                  const from = vals?.[0];
                  const to = vals?.[1];
                  if (!from || !to) return;
                  setDraft((d) => ({ ...d, range: [from.toDate(), to.toDate()] }));
                }}
              />
              {policy.data?.maxListWindowDays ? (
                <Text style={{ fontSize: 12 }} type="secondary">
                  {t('audit.exports.create.timeRangeHint', {
                    days: policy.data.maxListWindowDays,
                  })}
                </Text>
              ) : null}
              {policy.data?.maxExportRows ? (
                <Text style={{ fontSize: 12 }} type="secondary">
                  {t('audit.exports.create.maxRowsHint', { rows: policy.data.maxExportRows })}
                </Text>
              ) : null}
            </div>
            {kind === 'operation_logs' ? (
              <>
                <div className={styles.field}>
                  <Text>{t('audit.exports.create.action')}</Text>
                  <Input
                    value={action}
                    onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value }))}
                  />
                </div>
                <div className={styles.field}>
                  <Text>{t('audit.exports.create.actor')}</Text>
                  <AuditUserSearchSelect
                    enabled={canSearchUsers}
                    value={actorUserId}
                    onChange={(id) => setDraft((d) => ({ ...d, actorUserId: id }))}
                  />
                </div>
              </>
            ) : null}
            {kind === 'conversations' || kind === 'user_timeline' ? (
              <div className={styles.field}>
                <Text>{t('audit.exports.create.user')}</Text>
                <AuditUserSearchSelect
                  enabled={canSearchUsers}
                  value={userId}
                  onChange={(id) => setDraft((d) => ({ ...d, userId: id }))}
                />
              </div>
            ) : null}
            {kind === 'conversations' ? (
              <>
                <div className={styles.field}>
                  <Text>{t('audit.exports.create.topicId')}</Text>
                  <Input
                    value={topicId}
                    onChange={(e) => setDraft((d) => ({ ...d, topicId: e.target.value }))}
                  />
                </div>
                <div className={styles.field}>
                  <Text>{t('audit.exports.create.titleKeyword')}</Text>
                  <Input
                    value={q}
                    onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))}
                  />
                </div>
                <div className={styles.field}>
                  <Flexbox horizontal align="center" gap={8}>
                    <Switch
                      checked={includeBodies}
                      disabled={!bodyAllowed}
                      onChange={(v) => setDraft((d) => ({ ...d, includeBodies: Boolean(v) }))}
                    />
                    <Text>{t('audit.exports.create.includeBodies')}</Text>
                  </Flexbox>
                  {!bodyAllowed ? (
                    <Text style={{ fontSize: 12 }} type="secondary">
                      {t('audit.exports.create.includeBodiesDisabled')}
                    </Text>
                  ) : (
                    <Text style={{ fontSize: 12 }} type="secondary">
                      {t('audit.exports.create.includeBodiesHint')}
                    </Text>
                  )}
                </div>
              </>
            ) : null}
          </div>
        )}
      </Modal>
    );
  },
);

CreateExportModal.displayName = 'AuditCreateExportModal';

export default CreateExportModal;
