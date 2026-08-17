'use client';

import { Text } from '@lobehub/ui';
import { InputNumber, Select, Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  MODERATION_EFFECTIVE_ACTIONS,
  MODERATION_LIMITS,
  type ModerationEffectiveAction,
} from '@/const/platform/contentModeration';

import { effectiveActionLabel } from '../../format';
import { moderationStyles as styles } from '../../styles';
import type { ModerationConfigView } from '../draft';
import Field from '../Field';
import SettingsSection from '../SettingsSection';

export interface RecordsSectionProps {
  config: ModerationConfigView;
  disabled: boolean;
  onPatch: (patch: Partial<ModerationConfigView>) => void;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;

/**
 * 记录与保留 (design §6.3.8). Both switches trade a real cost for evidence — disk for
 * allow-records, privacy for full prompts — so each says so next to the control.
 */
const RecordsSection = memo<RecordsSectionProps>(({ config, disabled, onPatch }) => {
  const { t } = useTranslation('admin');
  const records = config.records;
  const notify = config.notify;
  const invalidEmails = notify.emails.filter((email) => !EMAIL_PATTERN.test(email));

  return (
    <SettingsSection
      description={t('contentModeration.settings.records.desc')}
      title={t('contentModeration.settings.records.title')}
    >
      <div className={styles.fieldGrid}>
        <Field
          hint={t('contentModeration.settings.records.recordNonHitsHint')}
          label={t('contentModeration.settings.records.recordNonHits')}
        >
          <div className={styles.inlineSwitch}>
            <Switch
              checked={records.recordNonHits}
              disabled={disabled}
              onChange={(checked) =>
                onPatch({ records: { ...records, recordNonHits: Boolean(checked) } })
              }
            />
          </div>
        </Field>

        <Field
          hint={t('contentModeration.settings.records.storeFullPromptHint')}
          label={t('contentModeration.settings.records.storeFullPrompt')}
        >
          <div className={styles.inlineSwitch}>
            <Switch
              checked={records.storeFullPrompt}
              disabled={disabled}
              onChange={(checked) =>
                onPatch({ records: { ...records, storeFullPrompt: Boolean(checked) } })
              }
            />
          </div>
        </Field>

        <Field label={t('contentModeration.settings.records.hitRetention')}>
          <InputNumber
            disabled={disabled}
            max={MODERATION_LIMITS.HIT_RETENTION_MAX_DAYS}
            min={1}
            step={1}
            style={{ width: 140 }}
            value={records.hitRetentionDays}
            onChange={(next) =>
              onPatch({ records: { ...records, hitRetentionDays: Number(next ?? 1) } })
            }
          />
        </Field>
        <Field
          label={t('contentModeration.settings.records.nonHitRetention')}
          hint={t('contentModeration.settings.records.nonHitRetentionHint', {
            max: MODERATION_LIMITS.NON_HIT_RETENTION_MAX_DAYS,
          })}
        >
          <InputNumber
            disabled={disabled}
            max={MODERATION_LIMITS.NON_HIT_RETENTION_MAX_DAYS}
            min={0}
            step={1}
            style={{ width: 140 }}
            value={records.nonHitRetentionDays}
            onChange={(next) =>
              onPatch({ records: { ...records, nonHitRetentionDays: Number(next ?? 0) } })
            }
          />
        </Field>

        <Field
          hint={t('contentModeration.settings.records.notifyHint')}
          label={t('contentModeration.settings.records.notifyEnabled')}
        >
          <div className={styles.inlineSwitch}>
            <Switch
              checked={notify.enabled}
              disabled={disabled}
              onChange={(checked) => onPatch({ notify: { ...notify, enabled: Boolean(checked) } })}
            />
          </div>
        </Field>

        {notify.enabled ? (
          <>
            <Field label={t('contentModeration.settings.records.notifyActions')}>
              <Select
                disabled={disabled}
                mode="multiple"
                style={{ width: '100%' }}
                value={notify.onActions}
                options={MODERATION_EFFECTIVE_ACTIONS.map((value) => ({
                  label: effectiveActionLabel(t, value),
                  value,
                }))}
                onChange={(next) =>
                  onPatch({
                    notify: {
                      ...notify,
                      onActions: (Array.isArray(next) ? next : []) as ModerationEffectiveAction[],
                    },
                  })
                }
              />
            </Field>
            <Field
              wide
              label={t('contentModeration.settings.records.notifyEmails')}
              extra={
                invalidEmails.length > 0 ? (
                  <Text data-testid="notify-email-error" type="danger">
                    {t('contentModeration.errors.notifyEmailInvalid', { email: invalidEmails[0] })}
                  </Text>
                ) : undefined
              }
            >
              <Select
                disabled={disabled}
                mode="tags"
                options={notify.emails.map((email) => ({ label: email, value: email }))}
                placeholder={t('contentModeration.settings.records.notifyEmailsPlaceholder')}
                style={{ width: '100%' }}
                value={notify.emails}
                onChange={(next) =>
                  onPatch({
                    notify: {
                      ...notify,
                      emails: Array.isArray(next) ? next.map((item) => String(item).trim()) : [],
                    },
                  })
                }
              />
            </Field>
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
});

RecordsSection.displayName = 'ModerationRecordsSection';

export default RecordsSection;
