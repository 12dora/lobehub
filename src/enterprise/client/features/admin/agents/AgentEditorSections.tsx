'use client';

import type { PlatformAgentVersionConfig } from '@lobechat/types';
import { Input, InputNumber, Select, TextArea } from '@lobehub/ui/base-ui';
import { cx } from 'antd-style';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import EmojiPicker from '@/components/EmojiPicker';
import { DEFAULT_AVATAR } from '@/const/meta';
import BackgroundSwatches from '@/features/AgentSetting/AgentMeta/BackgroundSwatches';

import {
  DESCRIPTION_ID,
  KEY_ID,
  NAME_ID,
  OPENING_MESSAGE_ID,
  OPENING_QUESTIONS_ID,
  PARAM_ROWS,
  styles,
  SYSTEM_ROLE_ID,
  TAGS_ID,
} from './agentEditorForm.styles';
import { FieldLabel } from './dependencyEditorShared';
import { AGENT_KEY_MAX_LENGTH } from './useAgentEditorForm';

type PatchConfig = <Key extends keyof PlatformAgentVersionConfig>(
  key: Key,
  next: PlatformAgentVersionConfig[Key],
) => void;

export interface AgentEditorIdentityFieldsProps {
  agentKey: string;
  changeAgentKey: (next: string) => void;
  config: PlatformAgentVersionConfig;
  isCreate: boolean;
  /** The platform's `default-inbox` assistant: its identifier is reserved and never editable. */
  isDefaultInbox?: boolean;
  keyInvalid: boolean;
  keyMissing: boolean;
  patchConfig: PatchConfig;
  readOnly: boolean;
  setDisplayName: (next: string) => void;
}

export const AgentEditorIdentityFields = memo<AgentEditorIdentityFieldsProps>(
  ({
    agentKey,
    changeAgentKey,
    config,
    isCreate,
    isDefaultInbox = false,
    keyInvalid,
    keyMissing,
    patchConfig,
    readOnly,
    setDisplayName,
  }) => {
    const { t } = useTranslation('admin');
    const background = config.backgroundColor ?? undefined;

    return (
      <>
        <div
          aria-label={t('agentCatalog.editor.identity')}
          className={styles.identityRow}
          role={'group'}
        >
          <div className={cx(styles.field, styles.identityAvatar)}>
            <FieldLabel>{t('agentCatalog.editor.avatar')}</FieldLabel>
            <EmojiPicker
              background={background}
              size={48}
              // Display-only fallback: an unset avatar must not render as the text "NU"
              // (`String(null)`); the platform default stays out of the persisted config.
              value={config.avatar ?? DEFAULT_AVATAR}
              onChange={(next: string) => patchConfig('avatar', next || null)}
            />
          </div>

          {/* One column: the swatch strip is part of the name box, ending exactly where it ends. */}
          <div className={styles.identityName}>
            <div className={styles.field}>
              <FieldLabel required htmlFor={NAME_ID}>
                {t('agentCatalog.editor.name')}
              </FieldLabel>
              <Input
                required
                aria-label={t('agentCatalog.editor.name')}
                disabled={readOnly}
                id={NAME_ID}
                placeholder={t('agentCatalog.editor.namePlaceholder')}
                value={config.displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>

            <div
              aria-label={t('agentCatalog.editor.background')}
              className={styles.identitySwatches}
              role={'group'}
            >
              <BackgroundSwatches
                value={background}
                onChange={(next) => patchConfig('backgroundColor', next || null)}
              />
            </div>
          </div>

          <div className={cx(styles.field, styles.identityKey)}>
            <FieldLabel
              htmlFor={KEY_ID}
              required={isCreate}
              help={
                isDefaultInbox
                  ? t('agentCatalog.editor.keyDefaultInboxDesc')
                  : isCreate
                    ? t('agentCatalog.editor.keyDesc')
                    : t('agentCatalog.editor.keyLockedDesc')
              }
            >
              {t('agentCatalog.editor.key')}
            </FieldLabel>
            <Input
              aria-label={t('agentCatalog.editor.key')}
              disabled={readOnly || !isCreate || isDefaultInbox}
              id={KEY_ID}
              maxLength={AGENT_KEY_MAX_LENGTH}
              placeholder={t('agentCatalog.editor.keyPlaceholder')}
              required={isCreate}
              value={agentKey}
              onChange={(event) => changeAgentKey(event.target.value)}
            />
            {keyInvalid || keyMissing ? (
              <span className={styles.error} role={'alert'}>
                {keyMissing
                  ? t('agentCatalog.editor.keyRequired')
                  : t('agentCatalog.editor.keyInvalid', { max: AGENT_KEY_MAX_LENGTH })}
              </span>
            ) : null}
          </div>
        </div>

        <div className={styles.field}>
          <FieldLabel htmlFor={DESCRIPTION_ID}>{t('agentCatalog.editor.description')}</FieldLabel>
          <TextArea
            aria-label={t('agentCatalog.editor.description')}
            autoSize={{ maxRows: 3, minRows: 1 }}
            disabled={readOnly}
            id={DESCRIPTION_ID}
            placeholder={t('agentCatalog.editor.descriptionPlaceholder')}
            value={config.description ?? ''}
            onChange={(event) => patchConfig('description', event.target.value || null)}
          />
        </div>
      </>
    );
  },
);

AgentEditorIdentityFields.displayName = 'AgentEditorIdentityFields';

export interface AgentEditorPromptFieldsProps {
  patchConfig: PatchConfig;
  readOnly: boolean;
  systemRole: string;
}

export const AgentEditorPromptFields = memo<AgentEditorPromptFieldsProps>(
  ({ patchConfig, readOnly, systemRole }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.field}>
        <FieldLabel
          required
          help={t('agentCatalog.editor.systemRoleDesc')}
          htmlFor={SYSTEM_ROLE_ID}
        >
          {t('agentCatalog.editor.systemRole')}
        </FieldLabel>
        <TextArea
          required
          aria-label={t('agentCatalog.editor.systemRole')}
          autoSize={{ maxRows: 18, minRows: 6 }}
          disabled={readOnly}
          id={SYSTEM_ROLE_ID}
          placeholder={t('agentCatalog.editor.systemRolePlaceholder')}
          value={systemRole}
          onChange={(event) => patchConfig('systemRole', event.target.value)}
        />
      </div>
    );
  },
);

AgentEditorPromptFields.displayName = 'AgentEditorPromptFields';

export interface AgentEditorParamsFieldsProps {
  modelParameters: PlatformAgentVersionConfig['modelParameters'];
  patchConfig: PatchConfig;
  readOnly: boolean;
}

export const AgentEditorParamsFields = memo<AgentEditorParamsFieldsProps>(
  ({ modelParameters, patchConfig, readOnly }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.stack}>
        <div className={styles.paramsGrid}>
          {PARAM_ROWS.map(({ key, max, min, step }) => (
            <div className={styles.field} key={key}>
              <FieldLabel htmlFor={`admin-agent-editor-param-${key}`}>
                {t(`agentCatalog.editor.param.${key}` as never)}
              </FieldLabel>
              <InputNumber
                disabled={readOnly}
                id={`admin-agent-editor-param-${key}`}
                max={max}
                min={min}
                placeholder={t('agentCatalog.editor.paramDefault')}
                step={step}
                value={modelParameters[key] ?? null}
                onChange={(next) =>
                  patchConfig('modelParameters', {
                    ...modelParameters,
                    [key]: typeof next === 'number' ? next : undefined,
                  })
                }
              />
            </div>
          ))}
        </div>
      </div>
    );
  },
);

AgentEditorParamsFields.displayName = 'AgentEditorParamsFields';

export interface AgentEditorMoreFieldsProps {
  config: PlatformAgentVersionConfig;
  connectors: ReactNode;
  patchConfig: PatchConfig;
  readOnly: boolean;
  skills: ReactNode;
}

export const AgentEditorMoreFields = memo<AgentEditorMoreFieldsProps>(
  ({ config, connectors, patchConfig, readOnly, skills }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.stack}>
        <div className={styles.field}>
          <FieldLabel htmlFor={TAGS_ID}>{t('agentCatalog.editor.tags')}</FieldLabel>
          <Select
            allowClear
            aria-label={t('agentCatalog.editor.tags')}
            disabled={readOnly}
            id={TAGS_ID}
            mode={'tags'}
            options={config.tags.map((tag) => ({ label: tag, value: tag }))}
            placeholder={t('agentCatalog.editor.tagsPlaceholder')}
            tokenSeparators={[',']}
            value={config.tags}
            onChange={(next) =>
              patchConfig('tags', Array.isArray(next) ? next : next ? [next] : [])
            }
          />
        </div>
        <div className={styles.field}>
          <FieldLabel htmlFor={OPENING_MESSAGE_ID}>
            {t('agentCatalog.editor.openingMessage')}
          </FieldLabel>
          <TextArea
            aria-label={t('agentCatalog.editor.openingMessage')}
            autoSize={{ maxRows: 6, minRows: 2 }}
            disabled={readOnly}
            id={OPENING_MESSAGE_ID}
            placeholder={t('agentCatalog.editor.openingMessagePlaceholder')}
            value={config.openingMessage ?? ''}
            onChange={(event) => patchConfig('openingMessage', event.target.value || null)}
          />
        </div>
        <div className={styles.field}>
          <FieldLabel
            help={t('agentCatalog.editor.openingQuestionsDesc')}
            htmlFor={OPENING_QUESTIONS_ID}
          >
            {t('agentCatalog.editor.openingQuestions')}
          </FieldLabel>
          <TextArea
            aria-label={t('agentCatalog.editor.openingQuestions')}
            autoSize={{ maxRows: 8, minRows: 3 }}
            disabled={readOnly}
            id={OPENING_QUESTIONS_ID}
            placeholder={t('agentCatalog.editor.openingQuestionsPlaceholder')}
            value={config.openingQuestions.join('\n')}
            onChange={(event) => patchConfig('openingQuestions', event.target.value.split('\n'))}
          />
        </div>
        {skills}
        {connectors}
      </div>
    );
  },
);

AgentEditorMoreFields.displayName = 'AgentEditorMoreFields';
