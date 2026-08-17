'use client';

import { Text } from '@lobehub/ui';
import { Checkbox, Input, Select, Switch, TextArea } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  MODERATION_MODES,
  MODERATION_REQUEST_KINDS,
  type ModerationMode,
  type ModerationRequestKind,
} from '@/const/platform/contentModeration';

import { modeLabel, requestKindLabel } from '../../format';
import { moderationStyles as styles } from '../../styles';
import type { ModerationCatalogModel } from '../../types';
import {
  encodedHeaderLength,
  MODERATION_BLOCK_MESSAGE_MAX,
  MODERATION_DOWNGRADE_MESSAGE_MAX,
  MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES,
  type ModerationConfigView,
} from '../draft';
import Field from '../Field';
import ModelSelect from '../ModelSelect';
import SettingsSection from '../SettingsSection';

export interface BasicSectionProps {
  catalog: readonly ModerationCatalogModel[];
  config: ModerationConfigView;
  disabled: boolean;
  /** Switching to `enforce` starts blocking real users — the caller confirms first. */
  onModeChange: (mode: ModerationMode) => void;
  onPatch: (patch: Partial<ModerationConfigView>) => void;
}

const BasicSection = memo<BasicSectionProps>(
  ({ catalog, config, disabled, onModeChange, onPatch }) => {
    const { t } = useTranslation('admin');
    // Within the character cap but still too large percent-encoded (CJK is ~9 bytes per char).
    const downgradeTooHeavy =
      encodedHeaderLength(config.messages.downgradeMessage) >
      MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES;

    return (
      <SettingsSection
        description={t('contentModeration.settings.basic.desc')}
        title={t('contentModeration.settings.basic.title')}
      >
        <div className={styles.fieldGrid}>
          <Field
            hint={t(`contentModeration.mode.${config.mode}Desc` as never)}
            label={t('contentModeration.settings.basic.mode')}
          >
            <Select
              disabled={disabled}
              options={MODERATION_MODES.map((value) => ({ label: modeLabel(t, value), value }))}
              style={{ width: '100%' }}
              value={config.mode}
              onChange={(next) => {
                if (typeof next !== 'string') return;
                onModeChange(next as ModerationMode);
              }}
            />
          </Field>

          <Field
            hint={t('contentModeration.settings.basic.requestKindsHint')}
            label={t('contentModeration.settings.basic.requestKinds')}
          >
            <div className={styles.inlineSwitch}>
              {MODERATION_REQUEST_KINDS.map((kind) => (
                <label className={styles.toolbarRow} key={kind}>
                  <Checkbox
                    checked={config.requestKinds.includes(kind)}
                    disabled={disabled}
                    onChange={(checked) => {
                      const set = new Set<ModerationRequestKind>(config.requestKinds);
                      if (checked) set.add(kind);
                      else set.delete(kind);
                      onPatch({
                        requestKinds: MODERATION_REQUEST_KINDS.filter((item) => set.has(item)),
                      });
                    }}
                  />
                  <span>{requestKindLabel(t, kind)}</span>
                </label>
              ))}
            </div>
          </Field>

          <Field
            hint={t('contentModeration.settings.basic.blockMessageHint')}
            label={t('contentModeration.settings.basic.blockMessage')}
            extra={
              <span data-testid="block-message-counter">
                {t('contentModeration.settings.basic.charCount', {
                  max: MODERATION_BLOCK_MESSAGE_MAX,
                  used: config.messages.blockMessage.length,
                })}
              </span>
            }
          >
            <TextArea
              disabled={disabled}
              maxLength={MODERATION_BLOCK_MESSAGE_MAX}
              rows={3}
              value={config.messages.blockMessage}
              onChange={(event) =>
                onPatch({
                  messages: {
                    ...config.messages,
                    // Hard-stop at the schema limit so a paste cannot exceed it silently.
                    blockMessage: event.target.value.slice(0, MODERATION_BLOCK_MESSAGE_MAX),
                  },
                })
              }
            />
          </Field>

          <Field
            hint={t('contentModeration.settings.basic.showCategoryHint')}
            label={t('contentModeration.settings.basic.showCategory')}
          >
            <div className={styles.inlineSwitch}>
              <Switch
                checked={config.messages.showCategoryToUser}
                disabled={disabled}
                onChange={(checked) =>
                  onPatch({
                    messages: { ...config.messages, showCategoryToUser: Boolean(checked) },
                  })
                }
              />
            </div>
          </Field>

          <Field
            hint={t('contentModeration.settings.basic.downgradeModelHint')}
            label={t('contentModeration.settings.basic.downgradeModel')}
            extra={
              config.downgrade
                ? undefined
                : t('contentModeration.settings.basic.downgradeMissingHint')
            }
          >
            <ModelSelect
              catalog={catalog}
              disabled={disabled}
              value={config.downgrade}
              onChange={(value) =>
                onPatch({ downgrade: value && value.provider && value.model ? value : null })
              }
            />
          </Field>
          <Field
            hint={t('contentModeration.settings.basic.downgradeMessageHint')}
            label={t('contentModeration.settings.basic.downgradeMessage')}
            extra={
              <span data-testid="downgrade-message-counter">
                {t('contentModeration.settings.basic.charCount', {
                  max: MODERATION_DOWNGRADE_MESSAGE_MAX,
                  used: config.messages.downgradeMessage.length,
                })}
                {downgradeTooHeavy ? (
                  <>
                    {' · '}
                    <Text data-testid="downgrade-message-heavy" type="danger">
                      {t('contentModeration.errors.downgradeMessageTooHeavy', {
                        max: MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES,
                      })}
                    </Text>
                  </>
                ) : null}
              </span>
            }
          >
            <Input
              disabled={disabled}
              maxLength={MODERATION_DOWNGRADE_MESSAGE_MAX}
              value={config.messages.downgradeMessage}
              onChange={(event) =>
                onPatch({
                  messages: {
                    ...config.messages,
                    // This one rides on a response header, so the cap is much tighter than the
                    // block message and is enforced on paste as well as on typing.
                    downgradeMessage: event.target.value.slice(0, MODERATION_DOWNGRADE_MESSAGE_MAX),
                  },
                })
              }
            />
          </Field>
        </div>
      </SettingsSection>
    );
  },
);

BasicSection.displayName = 'ModerationBasicSection';

export default BasicSection;
