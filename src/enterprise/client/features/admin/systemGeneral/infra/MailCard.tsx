'use client';

import { Button } from '@lobehub/ui/base-ui';
import { Mail } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  AdminSystemInfraSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';

import { InfraSettingsCard } from '../InfraSettingsCard';
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

/** 邮件服务 card: read-only while the environment owns it, editable once it is managed here. */
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

    const locked = editor.conflict || editor.stale;

    return (
      <InfraSettingsCard
        banner={failOpen ? <InfraFailOpenAlert /> : undefined}
        canTest={canOperate}
        envVars={editor.editing ? undefined : MAIL_ENV}
        headerExtra={<InfraSourceTag source={view.source} />}
        icon={Mail}
        probe={editor.editing ? editor.probe : probe}
        probing={editor.editing ? editor.probing : probing}
        status={view.status}
        testDisabled={editor.editing && editor.blocked}
        title={t('systemGeneral.mail.title')}
        editor={
          editor.editing ? (
            <div className={formStyles.stack}>
              <InfraEditorAlerts
                conflict={editor.conflict}
                stale={editor.stale}
                onReload={() => void editor.reload()}
              />
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
            </div>
          ) : undefined
        }
        extraActions={
          editor.editing ? (
            <InfraEditorActions
              canCancel={view.source !== 'db'}
              canRevert={view.source === 'db' || failOpen}
              dirty={editor.dirty}
              invalid={editor.blocked}
              locked={locked}
              saving={editor.saving}
              source={view.source}
              onCancel={editor.cancelEdit}
              onRevert={editor.revertToEnv}
              onSave={() => void editor.save()}
            />
          ) : canOperate ? (
            <Button size="small" onClick={editor.beginEdit}>
              {t('systemGeneral.edit.switchToDb')}
            </Button>
          ) : null
        }
        fields={[
          {
            label: t('systemGeneral.mail.fields.provider'),
            value: t(`systemGeneral.mail.provider.${view.provider}`),
          },
          { label: t('systemGeneral.mail.fields.host'), value: unset(view.host) },
          { label: t('systemGeneral.mail.fields.port'), value: unset(view.port) },
          { label: t('systemGeneral.mail.fields.fromAddress'), value: unset(view.fromAddress) },
          { label: t('systemGeneral.mail.fields.senderName'), value: unset(view.senderName) },
          { label: t('systemGeneral.mail.fields.secure'), value: yesNo(view.secure) },
        ]}
        onTest={editor.editing ? () => void editor.test() : onTest}
      />
    );
  },
);

MailCard.displayName = 'AdminMailCard';
