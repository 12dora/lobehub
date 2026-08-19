'use client';

import { InputNumber, Select } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  MODERATION_CLASSIFIER_KINDS,
  MODERATION_LIMITS,
  type ModerationClassifierKind,
} from '@/const/platform/contentModeration';

import { classifierKindLabel } from '../../format';
import { moderationStyles as styles } from '../../styles';
import type { ModerationCatalogModel } from '../../types';
import type { ModerationConfigView, ModerationSettingsDraft } from '../draft';
import Field from '../Field';
import SettingsSection from '../SettingsSection';
import TestPanel from '../TestPanel';
import { LlmJudgeFields } from './classifier/LlmJudgeFields';
import { ModerationsApiFields } from './classifier/ModerationsApiFields';

export interface ClassifierSectionProps {
  canManage: boolean;
  catalog: readonly ModerationCatalogModel[];
  disabled: boolean;
  draft: ModerationSettingsDraft;
  /** Field-level message from a rejected save, when the server named this section. */
  fieldError?: { field?: string; message: string } | null;
  /** True while deferred keyword validation is catching up — a dry run would use stale rules. */
  keywordsPending?: boolean;
  onAddedKeysChange: (keys: string[]) => void;
  onPatch: (patch: Partial<ModerationConfigView>) => void;
  /** The endpoint the stored keys were saved against; drives the re-enter warning. */
  persistedBaseUrl?: string;
}

const ON_ERROR_VALUES = ['allow', 'block'] as const;

/**
 * 分类器 (design §6.3.3). Existing Moderations API keys are shown masked and can only be
 * kept or removed; new keys are write-only inputs that never come back from the server.
 */
const ClassifierSection = memo<ClassifierSectionProps>(
  ({
    canManage,
    catalog,
    disabled,
    draft,
    fieldError,
    keywordsPending,
    onAddedKeysChange,
    onPatch,
    persistedBaseUrl,
  }) => {
    const { t } = useTranslation('admin');
    const classifier = draft.config.classifier;

    const patchClassifier = (patch: Partial<ModerationConfigView['classifier']>) =>
      onPatch({ classifier: { ...classifier, ...patch } });

    return (
      <SettingsSection
        description={t('contentModeration.settings.classifier.desc')}
        title={t('contentModeration.settings.classifier.title')}
      >
        <div className={styles.fieldGrid}>
          <Field label={t('contentModeration.settings.classifier.kind')}>
            <Select
              disabled={disabled}
              style={{ width: '100%' }}
              value={classifier.kind}
              options={MODERATION_CLASSIFIER_KINDS.map((value) => ({
                label: classifierKindLabel(t, value),
                value,
              }))}
              onChange={(next) => {
                const kind = (next as ModerationClassifierKind) ?? 'none';
                patchClassifier({
                  kind,
                  // Seed the sub-form so the required-field validation has something to bind to.
                  ...(kind === 'llm_judge' && !classifier.llmJudge
                    ? { llmJudge: { model: '', provider: '' } }
                    : {}),
                  ...(kind === 'moderations_api' && !classifier.moderationsApi
                    ? { moderationsApi: { apiKeys: [], baseUrl: '', model: '' } }
                    : {}),
                });
              }}
            />
          </Field>
          {classifier.kind === 'none' ? null : (
            <Field
              hint={t('contentModeration.settings.classifier.onErrorHint')}
              label={t('contentModeration.settings.classifier.onError')}
            >
              <Select
                disabled={disabled}
                style={{ width: '100%' }}
                value={classifier.onError}
                options={ON_ERROR_VALUES.map((value) => ({
                  label: t(`contentModeration.settings.classifier.onErrorValue.${value}` as never),
                  value,
                }))}
                onChange={(next) =>
                  patchClassifier({ onError: (next as 'allow' | 'block') ?? 'allow' })
                }
              />
            </Field>
          )}
        </div>

        {classifier.kind === 'llm_judge' ? (
          <LlmJudgeFields
            catalog={catalog}
            classifier={classifier}
            disabled={disabled}
            patchClassifier={patchClassifier}
          />
        ) : null}

        {classifier.kind === 'moderations_api' ? (
          <ModerationsApiFields
            addedApiKeys={draft.addedApiKeys}
            classifier={classifier}
            disabled={disabled}
            fieldError={fieldError}
            patchClassifier={patchClassifier}
            persistedBaseUrl={persistedBaseUrl}
            onAddedKeysChange={onAddedKeysChange}
          />
        ) : null}

        {classifier.kind === 'none' ? null : (
          <div className={styles.fieldGrid}>
            <Field label={t('contentModeration.settings.classifier.timeout')}>
              <InputNumber
                disabled={disabled}
                max={MODERATION_LIMITS.CLASSIFIER_TIMEOUT_MAX_MS}
                min={500}
                step={500}
                style={{ width: 160 }}
                value={classifier.timeoutMs}
                onChange={(next) => patchClassifier({ timeoutMs: Number(next ?? 0) })}
              />
            </Field>
            <Field label={t('contentModeration.settings.classifier.retry')}>
              <InputNumber
                disabled={disabled}
                max={MODERATION_LIMITS.CLASSIFIER_RETRY_MAX}
                min={0}
                step={1}
                style={{ width: 120 }}
                value={classifier.retryCount}
                onChange={(next) => patchClassifier({ retryCount: Number(next ?? 0) })}
              />
            </Field>
          </div>
        )}

        <TestPanel
          canManage={canManage}
          draft={draft}
          keywordsPending={keywordsPending}
          persistedBaseUrl={persistedBaseUrl}
        />
      </SettingsSection>
    );
  },
);

ClassifierSection.displayName = 'ModerationClassifierSection';

export default ClassifierSection;
