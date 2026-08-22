'use client';

import { Button } from '@lobehub/ui/base-ui';
import { Mail } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  AdminSystemInfraSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';

import { InfraProbeResult, InfraSettingsCard } from '../InfraSettingsCard';
import {
  fingerprintMailDraft,
  settleMailDraft,
  toMailConfig,
  toMailDisableConfig,
  toMailDraft,
  validateMailDraft,
} from './draft';
import {
  InfraEditorActions,
  InfraEditorAlerts,
  InfraFailOpenAlert,
  InfraSourceTag,
  isInfraFailOpen,
} from './editorChrome';
import { useInfraValueFormatters } from './format';
import { MailForm } from './MailForm';
import type { InfraSettingsMutationService } from './service';
import { infraFormStyles as formStyles } from './styles';
import { useInfraEditModal } from './useInfraEditModal';
import { useInfraSettingsEditor } from './useInfraSettingsEditor';

/** Environment variables that drive outbound email when it is not configured from the panel. */
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

export interface MailCardProps {
  canOperate: boolean;
  onTest: () => void;
  probe?: AdminSystemTestDependencyResult;
  probing: boolean;
  service?: InfraSettingsMutationService;
  view: AdminSystemInfraSettings['mail'];
}

/** 邮件服务 card: who sends, from where; the credentials and the rest live behind 编辑 / 详情. */
export const MailCard = memo<MailCardProps>(
  ({ canOperate, onTest, probe, probing, service, view }) => {
    const { t } = useTranslation('admin');
    const { unset, yesNo } = useInfraValueFormatters();

    const seed = useMemo(() => toMailDraft(view), [view]);
    const failOpen = isInfraFailOpen(view);

    const editor = useInfraSettingsEditor({
      canOperate,
      dependency: 'mail',
      fingerprint: fingerprintMailDraft,
      revision: view.revision,
      seed,
      revealErrors: failOpen,
      service,
      settle: settleMailDraft,
      source: view.source,
      toConfig: toMailConfig,
      toDisableConfig: toMailDisableConfig,
      validate: validateMailDraft,
    });

    const editModal = useInfraEditModal({
      beginEdit: editor.beginEdit,
      cancelEdit: editor.cancelEdit,
      dirty: editor.dirty,
      saveCount: editor.saveCount,
    });
    const locked = editor.conflict || editor.stale;

    const providerField = {
      label: t('systemGeneral.mail.fields.provider'),
      value: t(`systemGeneral.mail.provider.${view.provider}`),
    };
    const fromAddressField = {
      label: t('systemGeneral.mail.fields.fromAddress'),
      value: unset(view.fromAddress),
    };
    const hostField = { label: t('systemGeneral.mail.fields.host'), value: unset(view.host) };
    const portField = { label: t('systemGeneral.mail.fields.port'), value: unset(view.port) };
    const secureField = { label: t('systemGeneral.mail.fields.secure'), value: yesNo(view.secure) };

    /**
     * Who the mail claims to be from, and the relay that has to accept it.
     *
     * The sender name and the address are one identity — the way a recipient sees them — so they
     * share a row in the form they are actually sent in, instead of costing a summary row each.
     */
    const summaryFields = [
      providerField,
      {
        ...fromAddressField,
        value:
          view.senderName && view.fromAddress
            ? `${view.senderName} <${view.fromAddress}>`
            : fromAddressField.value,
      },
      hostField,
      portField,
      secureField,
    ];

    /** 详情 spells every stored field out, one row each — the username included. */
    const detailsFields = [
      providerField,
      fromAddressField,
      { label: t('systemGeneral.mail.fields.senderName'), value: unset(view.senderName) },
      hostField,
      portField,
      secureField,
      { label: t('systemGeneral.mail.fields.user'), value: unset(view.smtpUser) },
    ];

    return (
      <InfraSettingsCard
        banner={failOpen ? <InfraFailOpenAlert /> : undefined}
        canTest={canOperate}
        detailsFields={detailsFields}
        editOpen={editModal.open}
        envVars={MAIL_ENV}
        fields={summaryFields}
        headerExtra={<InfraSourceTag source={view.source} />}
        icon={Mail}
        probe={probe}
        probing={probing}
        status={view.status}
        title={t('systemGeneral.mail.title')}
        editActions={
          canOperate ? (
            <>
              <Button
                disabled={editor.blocked || locked}
                loading={editor.probing}
                size="small"
                onClick={() => void editor.test()}
              >
                {t('systemGeneral.testConnection')}
              </Button>
              <InfraEditorActions
                canCancel
                canRevert={view.source === 'db' || failOpen}
                dirty={editor.dirty}
                invalid={editor.blocked}
                locked={locked}
                saving={editor.saving}
                source={view.source}
                onCancel={editModal.requestClose}
                onRevert={editor.revertToEnv}
                onSave={() => void editor.save()}
              />
            </>
          ) : undefined
        }
        editor={
          canOperate ? (
            <div className={formStyles.stack}>
              <InfraEditorAlerts
                conflict={editor.conflict}
                stale={editor.stale}
                onReload={() => void editor.reload()}
              />
              {failOpen ? <InfraFailOpenAlert /> : null}
              {view.source !== 'db' && !failOpen ? (
                <span className={formStyles.hint}>{t('systemGeneral.edit.seededFromEnvMail')}</span>
              ) : null}
              <MailForm
                disabled={editor.saving || locked}
                draft={editor.draft}
                errors={editor.errors}
                onPatch={editor.patch}
              />
              <span className={formStyles.hint}>{t('systemGeneral.edit.applyHint')}</span>
              <InfraProbeResult probe={editor.probe} />
            </div>
          ) : undefined
        }
        onEditOpenChange={editModal.onOpenChange}
        onTest={onTest}
      />
    );
  },
);

MailCard.displayName = 'AdminMailCard';
