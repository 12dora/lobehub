'use client';

import { Tag, Text } from '@lobehub/ui';
import { Button, Input, InputNumber, InputPassword, Select, TextArea } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  MODERATION_CLASSIFIER_KINDS,
  MODERATION_LIMITS,
  type ModerationClassifierKind,
} from '@/const/platform/contentModeration';

import { classifierKindLabel, moderationEndpointChanged } from '../../format';
import { moderationStyles as styles } from '../../styles';
import type { ModerationCatalogModel } from '../../types';
import type { ModerationConfigView, ModerationSettingsDraft } from '../draft';
import Field from '../Field';
import ModelSelect from '../ModelSelect';
import SettingsSection from '../SettingsSection';
import TestPanel from '../TestPanel';

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
    // The server refuses to reuse keys across endpoints, so once the URL is edited the stored
    // keys are already gone from the admin's point of view — say so before they hit 保存.
    const endpointChanged =
      classifier.kind === 'moderations_api' &&
      (classifier.moderationsApi?.apiKeys.length ?? 0) > 0 &&
      moderationEndpointChanged(persistedBaseUrl, classifier.moderationsApi?.baseUrl);

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
          <div className={styles.fieldGrid}>
            <Field
              hint={t('contentModeration.settings.classifier.judgeModelHint')}
              label={t('contentModeration.settings.classifier.judgeModel')}
            >
              <ModelSelect
                catalog={catalog}
                disabled={disabled}
                value={
                  classifier.llmJudge?.provider
                    ? {
                        model: classifier.llmJudge.model,
                        provider: classifier.llmJudge.provider,
                      }
                    : null
                }
                onChange={(value) =>
                  patchClassifier({
                    llmJudge: {
                      extraGuidance: classifier.llmJudge?.extraGuidance,
                      model: value?.model ?? '',
                      provider: value?.provider ?? '',
                    },
                  })
                }
              />
            </Field>
            <Field
              hint={t('contentModeration.settings.classifier.extraGuidanceHint')}
              label={t('contentModeration.settings.classifier.extraGuidance')}
            >
              <TextArea
                disabled={disabled}
                rows={3}
                value={classifier.llmJudge?.extraGuidance ?? ''}
                onChange={(event) =>
                  patchClassifier({
                    llmJudge: {
                      extraGuidance: event.target.value || undefined,
                      model: classifier.llmJudge?.model ?? '',
                      provider: classifier.llmJudge?.provider ?? '',
                    },
                  })
                }
              />
            </Field>
          </div>
        ) : null}

        {classifier.kind === 'moderations_api' ? (
          <div className={styles.fieldGrid}>
            <Field
              hint={t('contentModeration.settings.classifier.baseUrlHint')}
              label={t('contentModeration.settings.classifier.baseUrl')}
            >
              <Input
                disabled={disabled}
                placeholder="https://api.openai.com"
                value={classifier.moderationsApi?.baseUrl ?? ''}
                onChange={(event) =>
                  patchClassifier({
                    moderationsApi: {
                      apiKeys: classifier.moderationsApi?.apiKeys ?? [],
                      baseUrl: event.target.value,
                      model: classifier.moderationsApi?.model ?? '',
                    },
                  })
                }
              />
            </Field>
            <Field label={t('contentModeration.settings.classifier.apiModel')}>
              <Input
                disabled={disabled}
                placeholder="omni-moderation-latest"
                value={classifier.moderationsApi?.model ?? ''}
                onChange={(event) =>
                  patchClassifier({
                    moderationsApi: {
                      apiKeys: classifier.moderationsApi?.apiKeys ?? [],
                      baseUrl: classifier.moderationsApi?.baseUrl ?? '',
                      model: event.target.value,
                    },
                  })
                }
              />
            </Field>
            <Field
              wide
              hint={t('contentModeration.settings.classifier.apiKeysHint')}
              label={t('contentModeration.settings.classifier.apiKeys')}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className={styles.formRow}>
                  {(classifier.moderationsApi?.apiKeys ?? []).length === 0 ? (
                    <Text className={styles.hintText}>
                      {t('contentModeration.settings.classifier.noStoredKeys')}
                    </Text>
                  ) : (
                    (classifier.moderationsApi?.apiKeys ?? []).map((key) => (
                      <Tag
                        closable={!disabled}
                        color={endpointChanged ? 'warning' : undefined}
                        data-testid={`stored-key-${key.fingerprint}`}
                        key={key.fingerprint}
                        onClose={() =>
                          patchClassifier({
                            moderationsApi: {
                              apiKeys: (classifier.moderationsApi?.apiKeys ?? []).filter(
                                (item) => item.fingerprint !== key.fingerprint,
                              ),
                              baseUrl: classifier.moderationsApi?.baseUrl ?? '',
                              model: classifier.moderationsApi?.model ?? '',
                            },
                          })
                        }
                      >
                        {endpointChanged
                          ? t('contentModeration.settings.classifier.keyWillBeRemoved', {
                              masked: key.masked,
                            })
                          : key.masked}
                      </Tag>
                    ))
                  )}
                </div>
                {endpointChanged ? (
                  <Text data-testid="endpoint-changed-warning" type="warning">
                    {t('contentModeration.settings.classifier.endpointChanged')}
                  </Text>
                ) : null}
                {fieldError ? (
                  <Text data-testid="classifier-field-error" type="danger">
                    {fieldError.message}
                  </Text>
                ) : null}
                {draft.addedApiKeys.map((value, index) => (
                  <div className={styles.toolbarRow} key={`new-key-${index}`}>
                    <InputPassword
                      disabled={disabled}
                      placeholder={t('contentModeration.settings.classifier.newKeyPlaceholder')}
                      style={{ width: 320 }}
                      value={value}
                      onChange={(event) => {
                        const next = [...draft.addedApiKeys];
                        next[index] = event.target.value;
                        onAddedKeysChange(next);
                      }}
                    />
                    <Button
                      disabled={disabled}
                      size="small"
                      type="text"
                      onClick={() =>
                        onAddedKeysChange(draft.addedApiKeys.filter((_, i) => i !== index))
                      }
                    >
                      {t('contentModeration.settings.classifier.removeKey')}
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    disabled={disabled}
                    size="small"
                    onClick={() => onAddedKeysChange([...draft.addedApiKeys, ''])}
                  >
                    {t('contentModeration.settings.classifier.addKey')}
                  </Button>
                </div>
              </div>
            </Field>
          </div>
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
