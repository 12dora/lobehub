'use client';

import { Alert, Icon, InputNumber, Text, Tooltip } from '@lobehub/ui';
import { Modal, Select, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { CircleHelp } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import type {
  AdminAuditPolicy,
  AdminAuditPolicyUpdateInput,
} from '@/enterprise/client/services/adminAudit';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import { openAuditReasonModal } from '../shared/openAuditReasonModal';
import { clampField, clampInt, POLICY_BOUNDS } from './policyBounds';

const styles = createStaticStyles(({ css, cssVar }) => ({
  helpButton: css`
    cursor: help;

    display: inline-flex;
    align-items: center;

    padding: 0;
    border: none;

    color: ${cssVar.colorTextTertiary};

    background: none;

    &:hover,
    &:focus-visible {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  labelRow: css`
    display: flex;
    gap: 6px;
    align-items: center;
  `,
  riskList: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    margin: 0;
    padding-inline-start: 20px;
  `,
}));

/**
 * Help icon + tooltip for a policy field. Keyboard users reach the copy by focusing the
 * button (hover alone would hide it from them), same contract as the other admin fields.
 */
const FieldHelp = memo<{ hint: React.ReactNode; label: string }>(({ hint, label }) => {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} title={hint} onOpenChange={setOpen}>
      <button
        aria-label={t('audit.retention.policy.helpFor', { field: label })}
        className={styles.helpButton}
        type="button"
        onBlur={() => setOpen(false)}
        onFocus={() => setOpen(true)}
      >
        <Icon icon={CircleHelp} size={14} />
      </button>
    </Tooltip>
  );
});

FieldHelp.displayName = 'AuditPolicyFieldHelp';

const PolicyEditModal = memo<{
  authMethod?: AdminReauthAuthMethod | null;
  onClose: () => void;
  onSubmit: (input: AdminAuditPolicyUpdateInput) => Promise<void>;
  open: boolean;
  policy?: AdminAuditPolicy;
}>(({ open, onClose, policy, onSubmit, authMethod }) => {
  const { t } = useTranslation('admin');
  const [contentAccessMode, setContentAccessMode] =
    useState<AdminAuditPolicy['contentAccessMode']>('metadata_only');
  // Matches the DB default (PLATFORM_AUDIT_POLICY_DEFAULTS.redactionProfile) so a save
  // fired before the policy hydrates cannot silently weaken redaction.
  const [redactionProfile, setRedactionProfile] =
    useState<AdminAuditPolicy['redactionProfile']>('strict');
  const [conversationRetentionDays, setConversationRetentionDays] = useState(90);
  const [operationLogRetentionDays, setOperationLogRetentionDays] = useState(90);
  const [exportArtifactRetentionDays, setExportArtifactRetentionDays] = useState(30);
  const [maxListWindowDays, setMaxListWindowDays] = useState(30);
  const [maxExportRows, setMaxExportRows] = useState(100_000);
  const [messageBodyInExport, setMessageBodyInExport] = useState(false);
  const [hasConflict, setHasConflict] = useState(false);
  const initializedOpenRef = useRef(false);
  const latestRevisionRef = useRef<number | null>(null);

  // Populate once per open session. Later policy refreshes advance only the retry
  // revision and preserve the operator's local draft for review.
  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false;
      latestRevisionRef.current = null;
      setHasConflict(false);
      return;
    }
    if (!policy) return;

    if (!initializedOpenRef.current) {
      initializedOpenRef.current = true;
      latestRevisionRef.current = policy.revision;
      setContentAccessMode(policy.contentAccessMode);
      setRedactionProfile(policy.redactionProfile);
      setConversationRetentionDays(policy.conversationRetentionDays);
      setOperationLogRetentionDays(policy.operationLogRetentionDays);
      setExportArtifactRetentionDays(policy.exportArtifactRetentionDays);
      setMaxListWindowDays(policy.maxListWindowDays);
      setMaxExportRows(policy.maxExportRows);
      setMessageBodyInExport(policy.messageBodyInExport);
      setHasConflict(false);
      return;
    }

    if (latestRevisionRef.current !== policy.revision) {
      latestRevisionRef.current = policy.revision;
      setHasConflict(true);
    }
  }, [open, policy]);

  /**
   * `hint` is static guidance only — it sits in a tooltip behind a help icon so the
   * rows stay aligned and the modal does not grow a paragraph per field.
   */
  const field = (label: string, control: React.ReactNode, hint?: React.ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBlockEnd: 12 }}>
      <div className={styles.labelRow}>
        <Text>{label}</Text>
        {hint ? <FieldHelp hint={hint} label={label} /> : null}
      </div>
      {control}
    </div>
  );

  const numberInput = (
    value: number,
    onChange: (n: number) => void,
    bounds: { max: number; min: number },
  ) => (
    <InputNumber
      max={bounds.max}
      min={bounds.min}
      style={{ width: '100%' }}
      value={value}
      onChange={(v) => {
        const n = typeof v === 'number' ? v : Number(v);
        onChange(clampInt(n, bounds.min, bounds.max));
      }}
    />
  );

  const handleOk = () => {
    if (!policy) return;
    const fields = {
      contentAccessMode,
      conversationRetentionDays: clampField('conversationRetentionDays', conversationRetentionDays),
      exportArtifactRetentionDays: clampField(
        'exportArtifactRetentionDays',
        exportArtifactRetentionDays,
      ),
      maxExportRows: clampField('maxExportRows', maxExportRows),
      maxListWindowDays: clampField('maxListWindowDays', maxListWindowDays),
      messageBodyInExport,
      operationLogRetentionDays: clampField('operationLogRetentionDays', operationLogRetentionDays),
      redactionProfile,
    };

    const apply = () => {
      openAuditReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({
          ...fields,
          expectedRevision: latestRevisionRef.current ?? policy.revision,
          reason,
        }),
        description: t('audit.retention.policy.reasonDesc'),
        onSubmit: async (payload) => {
          await onSubmit(payload as AdminAuditPolicyUpdateInput);
          onClose();
        },
        submitLabel: t('audit.retention.policy.save'),
        targetLabel: `rev ${policy.revision}`,
        title: t('audit.retention.policy.edit'),
      });
    };

    // One acknowledgement per save, not one per risky field: an operator who widens both
    // content access and redaction in the same edit sees both consequences in one dialog.
    const turningRedactionOff =
      fields.redactionProfile === 'off' && policy.redactionProfile !== 'off';
    const allowingContent =
      fields.contentAccessMode === 'content_allowed' &&
      policy.contentAccessMode !== 'content_allowed';

    const risks: string[] = [];
    if (allowingContent) {
      // The stock warning promises credentials stay masked. That is only true while a mask
      // still runs, so the copy follows the profile this save will leave in place — which
      // also covers a policy that was already 'off' before this edit.
      risks.push(
        fields.redactionProfile === 'off'
          ? t('audit.retention.policy.contentAllowedWarnUnmasked')
          : t('audit.retention.policy.contentAllowedWarn'),
      );
    }
    if (turningRedactionOff) {
      risks.push(t('audit.retention.policy.redactionOffConfirmBody'));
    }

    if (risks.length === 0) {
      apply();
      return;
    }

    openDangerConfirm({
      // Several consequences need real block elements: newlines inside one string collapse.
      content:
        risks.length > 1 ? (
          <ul className={styles.riskList}>
            {risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        ) : (
          risks[0]
        ),
      // A single risk keeps its own specific heading; both together need a neutral one.
      title:
        risks.length > 1
          ? t('audit.retention.policy.riskConfirmTitle')
          : turningRedactionOff
            ? t('audit.retention.policy.redactionOffConfirmTitle')
            : t('audit.retention.policy.contentAllowedWarnTitle'),
      onConfirm: apply,
    });
  };

  return (
    <Modal
      cancelText={t('users.modals.cancel')}
      okText={t('audit.retention.policy.save')}
      open={open}
      title={t('audit.retention.policy.edit')}
      width={560}
      onCancel={onClose}
      onOk={handleOk}
    >
      {hasConflict ? (
        <Alert
          showIcon
          description={t('audit.retention.policy.conflictDescription')}
          message={t('audit.retention.policy.conflictTitle')}
          type="warning"
        />
      ) : null}
      {field(
        t('audit.retention.policy.contentAccessMode'),
        <Select
          style={{ width: '100%' }}
          value={contentAccessMode}
          options={[
            { label: t('audit.retention.policy.mode.disabled'), value: 'disabled' },
            { label: t('audit.retention.policy.mode.metadata_only'), value: 'metadata_only' },
            { label: t('audit.retention.policy.mode.content_allowed'), value: 'content_allowed' },
          ]}
          onChange={(v) => setContentAccessMode(v as AdminAuditPolicy['contentAccessMode'])}
        />,
      )}
      {field(
        t('audit.retention.policy.redactionProfile'),
        <Select
          style={{ width: '100%' }}
          value={redactionProfile}
          options={[
            { label: t('audit.retention.redaction.strict'), value: 'strict' },
            { label: t('audit.retention.redaction.standard'), value: 'standard' },
            { label: t('audit.retention.redaction.off'), value: 'off' },
          ]}
          onChange={(v) => setRedactionProfile(v as AdminAuditPolicy['redactionProfile'])}
        />,
        <>
          <div>{t('audit.retention.policy.redactionProfileHint.strict')}</div>
          <div>{t('audit.retention.policy.redactionProfileHint.standard')}</div>
          <div>{t('audit.retention.policy.redactionProfileHint.off')}</div>
        </>,
      )}
      {field(
        t('audit.retention.policy.conversationDays'),
        numberInput(
          conversationRetentionDays,
          setConversationRetentionDays,
          POLICY_BOUNDS.conversationRetentionDays,
        ),
      )}
      {field(
        t('audit.retention.policy.operationLogDays'),
        numberInput(
          operationLogRetentionDays,
          setOperationLogRetentionDays,
          POLICY_BOUNDS.operationLogRetentionDays,
        ),
      )}
      {field(
        t('audit.retention.policy.exportArtifactDays'),
        numberInput(
          exportArtifactRetentionDays,
          setExportArtifactRetentionDays,
          POLICY_BOUNDS.exportArtifactRetentionDays,
        ),
      )}
      {field(
        t('audit.retention.policy.maxListWindowDays'),
        numberInput(maxListWindowDays, setMaxListWindowDays, POLICY_BOUNDS.maxListWindowDays),
      )}
      {field(
        t('audit.retention.policy.maxExportRows'),
        numberInput(maxExportRows, setMaxExportRows, POLICY_BOUNDS.maxExportRows),
      )}
      {field(
        t('audit.retention.policy.messageBodyInExport'),
        <Switch
          checked={messageBodyInExport}
          onChange={(v) => setMessageBodyInExport(Boolean(v))}
        />,
      )}
    </Modal>
  );
});

export default PolicyEditModal;
