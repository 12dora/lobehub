'use client';

import { Text } from '@lobehub/ui';
import { InputNumber, Select, Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { moderationStyles as styles } from '../../styles';
import type { ModerationConfigView } from '../draft';
import Field from '../Field';
import SettingsSection from '../SettingsSection';

export interface AutoBanSectionProps {
  config: ModerationConfigView;
  disabled: boolean;
  /** Turning auto-ban ON is confirmed by the caller — it can lock real users out. */
  onEnableChange: (enabled: boolean) => void;
  onPatch: (patch: Partial<ModerationConfigView>) => void;
}

const AutoBanSection = memo<AutoBanSectionProps>(
  ({ config, disabled, onEnableChange, onPatch }) => {
    const { t } = useTranslation('admin');
    const autoBan = config.autoBan;

    return (
      <SettingsSection
        description={t('contentModeration.settings.autoBan.desc')}
        title={t('contentModeration.settings.autoBan.title')}
      >
        <Field label={t('contentModeration.settings.autoBan.enabled')}>
          <div className={styles.toolbarRow}>
            <Switch
              checked={autoBan.enabled}
              disabled={disabled}
              onChange={(checked) => onEnableChange(Boolean(checked))}
            />
            <Text className={styles.hintText}>
              {t('contentModeration.settings.autoBan.enabledHint')}
            </Text>
          </div>
        </Field>

        {autoBan.enabled ? (
          <div className={styles.formRow}>
            <Field label={t('contentModeration.settings.autoBan.threshold')}>
              <InputNumber
                disabled={disabled}
                max={10_000}
                min={1}
                step={1}
                style={{ width: 140 }}
                value={autoBan.threshold}
                onChange={(next) =>
                  onPatch({ autoBan: { ...autoBan, threshold: Number(next ?? 1) } })
                }
              />
            </Field>
            <Field label={t('contentModeration.settings.autoBan.window')}>
              <InputNumber
                disabled={disabled}
                max={3650}
                min={1}
                step={1}
                style={{ width: 140 }}
                value={autoBan.windowDays}
                onChange={(next) =>
                  onPatch({ autoBan: { ...autoBan, windowDays: Number(next ?? 1) } })
                }
              />
            </Field>
            <Field label={t('contentModeration.settings.autoBan.duration')}>
              <div className={styles.toolbarRow}>
                <Select
                  disabled={disabled}
                  style={{ width: 160 }}
                  value={autoBan.durationDays === null ? 'permanent' : 'temporary'}
                  options={[
                    {
                      label: t('contentModeration.settings.autoBan.permanent'),
                      value: 'permanent',
                    },
                    {
                      label: t('contentModeration.settings.autoBan.temporary'),
                      value: 'temporary',
                    },
                  ]}
                  onChange={(next) =>
                    onPatch({
                      autoBan: {
                        ...autoBan,
                        durationDays: next === 'temporary' ? (autoBan.durationDays ?? 7) : null,
                      },
                    })
                  }
                />
                {autoBan.durationDays === null ? null : (
                  <InputNumber
                    aria-label={t('contentModeration.settings.autoBan.durationDays')}
                    disabled={disabled}
                    max={3650}
                    min={1}
                    step={1}
                    style={{ width: 120 }}
                    value={autoBan.durationDays}
                    onChange={(next) =>
                      onPatch({ autoBan: { ...autoBan, durationDays: Number(next ?? 1) } })
                    }
                  />
                )}
              </div>
            </Field>
          </div>
        ) : null}
      </SettingsSection>
    );
  },
);

AutoBanSection.displayName = 'ModerationAutoBanSection';

export default AutoBanSection;
