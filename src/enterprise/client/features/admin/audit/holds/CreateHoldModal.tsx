'use client';

import { Input, Text } from '@lobehub/ui';
import { Modal, Select } from '@lobehub/ui/base-ui';
import { DatePicker } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import type dayjs from 'dayjs';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type { AdminAuditLegalHoldsCreateInput } from '@/enterprise/client/services/adminAudit';

import AuditUserSearchSelect from '../shared/AuditUserSearchSelect';
import { openAuditReasonModal } from '../shared/openAuditReasonModal';

const styles = createStaticStyles(({ css }) => ({
  banner: css`
    margin-block-end: 12px;
    padding-block: 10px;
    padding-inline: 14px;
    border: 1px solid ${cssVar.colorWarningBorder};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorWarningBg};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-block-end: 12px;
  `,
}));

const SCOPE_TYPES = ['user', 'session', 'topic', 'workspace', 'global'] as const;

export interface CreateHoldModalProps {
  authMethod?: AdminReauthAuthMethod | null;
  canAuditRead: boolean;
  createLegalHold: (input: AdminAuditLegalHoldsCreateInput) => Promise<unknown>;
  onClose: () => void;
  onCreated: () => void;
  open: boolean;
}

const CreateHoldModal = memo<CreateHoldModalProps>(
  ({ open, onClose, onCreated, canAuditRead, authMethod, createLegalHold }) => {
    const { t } = useTranslation('admin');
    const [newScopeType, setNewScopeType] = useState<(typeof SCOPE_TYPES)[number]>('user');
    const [newScopeId, setNewScopeId] = useState('');
    const [newExpires, setNewExpires] = useState<dayjs.Dayjs | null>(null);

    const submitCreate = () => {
      openAuditReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason): AdminAuditLegalHoldsCreateInput => {
          // Discriminated union: keep scopeType as a literal so TS narrows correctly
          // (avoid assigning a wide scopeType union then patching scopeId).
          const expiresAt = newExpires ? newExpires.toDate() : undefined;
          if (newScopeType === 'global') {
            return { expiresAt, reason, scopeId: null, scopeType: 'global' };
          }
          if (newScopeType === 'user') {
            return { expiresAt, reason, scopeId: newScopeId.trim(), scopeType: 'user' };
          }
          if (newScopeType === 'session') {
            return { expiresAt, reason, scopeId: newScopeId.trim(), scopeType: 'session' };
          }
          if (newScopeType === 'topic') {
            return { expiresAt, reason, scopeId: newScopeId.trim(), scopeType: 'topic' };
          }
          return { expiresAt, reason, scopeId: newScopeId.trim(), scopeType: 'workspace' };
        },
        description: t('audit.holds.create.reasonDesc'),
        onSubmit: async (payload) => {
          await createLegalHold(payload as AdminAuditLegalHoldsCreateInput);
          onClose();
          setNewScopeId('');
          setNewExpires(null);
          onCreated();
        },
        submitLabel: t('audit.holds.create.submit'),
        targetLabel: newScopeType,
        title: t('audit.holds.create.title'),
        validateExtra: () => {
          if (newScopeType !== 'global' && !newScopeId.trim()) {
            return 'audit.holds.create.scopeIdRequired';
          }
          if (newExpires && newExpires.valueOf() <= Date.now()) {
            return 'audit.holds.create.expiresAtMustBeFuture';
          }
          return null;
        },
      });
    };

    return (
      <Modal
        cancelText={t('users.modals.cancel')}
        okText={t('audit.holds.create.continue')}
        open={open}
        title={t('audit.holds.create.title')}
        onCancel={onClose}
        onOk={submitCreate}
      >
        <div className={styles.banner}>{t('audit.holds.create.warning')}</div>
        <div className={styles.field}>
          <Text>{t('audit.holds.create.scopeType')}</Text>
          <Select
            style={{ width: '100%' }}
            value={newScopeType}
            options={SCOPE_TYPES.map((s) => ({
              label: t(`audit.holds.scopeType.${s}` as never, { defaultValue: s }),
              value: s,
            }))}
            onChange={(v) => setNewScopeType(v as (typeof SCOPE_TYPES)[number])}
          />
        </div>
        {newScopeType !== 'global' ? (
          <div className={styles.field}>
            <Text>{t('audit.holds.create.scopeId')}</Text>
            {newScopeType === 'user' ? (
              <AuditUserSearchSelect
                enabled={canAuditRead}
                value={newScopeId || undefined}
                onChange={(id) => setNewScopeId(id ?? '')}
              />
            ) : (
              <Input value={newScopeId} onChange={(e) => setNewScopeId(e.target.value)} />
            )}
          </div>
        ) : null}
        <div className={styles.field}>
          <Text>{t('audit.holds.create.expiresAt')}</Text>
          <DatePicker
            showTime
            placeholder={t('primitives.datePicker.placeholder')}
            style={{ width: '100%' }}
            value={newExpires}
            disabledDate={(current) => {
              // Disallow past calendar days; submit still requires a future instant.
              if (!current) return false;
              return current.endOf('day').valueOf() < Date.now();
            }}
            onChange={(v) => setNewExpires(v)}
          />
        </div>
      </Modal>
    );
  },
);

CreateHoldModal.displayName = 'CreateHoldModal';

export default CreateHoldModal;
