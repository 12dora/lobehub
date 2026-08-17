'use client';

import { Input, Segmented } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { MailDraft } from './draft';
import { InfraField, InfraSwitchRow } from './InfraField';
import { SecretField } from './SecretField';
import { infraFormStyles as styles } from './styles';

export interface MailFormProps {
  disabled: boolean;
  draft: MailDraft;
  /** Field name → resolved validation message. */
  errors: Record<string, string>;
  onPatch: (next: Partial<MailDraft>) => void;
}

/** Editable outbound email configuration (T8 interface §2). */
export const MailForm = memo<MailFormProps>(({ disabled, draft, errors, onPatch }) => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.stack}>
      <InfraField label={t('systemGeneral.mail.fields.provider')}>
        {(field) => (
          <div aria-labelledby={field.labelId} role="group">
            <Segmented
              disabled={disabled}
              value={draft.provider}
              options={[
                { label: t('systemGeneral.mail.provider.smtp'), value: 'smtp' },
                { label: t('systemGeneral.mail.provider.resend'), value: 'resend' },
              ]}
              onChange={(next) => onPatch({ provider: next as 'resend' | 'smtp' })}
            />
          </div>
        )}
      </InfraField>

      {draft.provider === 'smtp' ? (
        <>
          <div className={styles.fieldGrid}>
            <InfraField
              error={errors.host}
              hint={t('systemGeneral.mail.hints.host')}
              label={t('systemGeneral.mail.fields.host')}
            >
              {(field) => (
                <Input
                  {...field.control}
                  disabled={disabled}
                  placeholder="smtp.example.com"
                  value={draft.host}
                  onChange={(event) => onPatch({ host: event.target.value })}
                />
              )}
            </InfraField>
            <InfraField
              error={errors.port}
              hint={t('systemGeneral.mail.hints.port')}
              label={t('systemGeneral.mail.fields.port')}
            >
              {(field) => (
                <Input
                  {...field.control}
                  disabled={disabled}
                  inputMode="numeric"
                  placeholder="587"
                  value={draft.port}
                  onChange={(event) => onPatch({ port: event.target.value })}
                />
              )}
            </InfraField>
            <InfraField
              error={errors.user}
              hint={t('systemGeneral.mail.hints.user')}
              label={t('systemGeneral.mail.fields.user')}
            >
              {(field) => (
                <Input
                  {...field.control}
                  autoComplete="off"
                  disabled={disabled}
                  value={draft.user}
                  onChange={(event) => onPatch({ user: event.target.value })}
                />
              )}
            </InfraField>
            <SecretField
              disabled={disabled}
              error={errors.pass}
              hint={t('systemGeneral.mail.hints.pass')}
              label={t('systemGeneral.mail.fields.pass')}
              value={draft.pass}
              onChange={(next) => onPatch({ pass: next })}
            />
          </div>
          <InfraSwitchRow
            checked={draft.secure}
            disabled={disabled}
            hint={t('systemGeneral.mail.hints.secure')}
            label={t('systemGeneral.mail.fields.secure')}
            onChange={(checked) => onPatch({ secure: checked })}
          />
        </>
      ) : (
        <SecretField
          wide
          disabled={disabled}
          error={errors.resendApiKey}
          hint={t('systemGeneral.mail.hints.resendApiKey')}
          label={t('systemGeneral.mail.fields.resendApiKey')}
          value={draft.resendApiKey}
          onChange={(next) => onPatch({ resendApiKey: next })}
        />
      )}

      <div className={styles.fieldGrid}>
        <InfraField
          error={errors.fromAddress}
          hint={t('systemGeneral.mail.hints.fromAddress')}
          label={t('systemGeneral.mail.fields.fromAddress')}
        >
          {(field) => (
            <Input
              {...field.control}
              disabled={disabled}
              placeholder="noreply@example.com"
              value={draft.fromAddress}
              onChange={(event) => onPatch({ fromAddress: event.target.value })}
            />
          )}
        </InfraField>
        <InfraField
          error={errors.senderName}
          hint={t('systemGeneral.mail.hints.senderName')}
          label={t('systemGeneral.mail.fields.senderName')}
        >
          {(field) => (
            <Input
              {...field.control}
              disabled={disabled}
              value={draft.senderName}
              onChange={(event) => onPatch({ senderName: event.target.value })}
            />
          )}
        </InfraField>
      </div>
      <span className={styles.hint}>{t('systemGeneral.mail.hints.brandingOverride')}</span>
    </div>
  );
});

MailForm.displayName = 'AdminMailForm';
