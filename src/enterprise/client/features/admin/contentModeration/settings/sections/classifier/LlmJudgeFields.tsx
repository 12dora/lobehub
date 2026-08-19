'use client';

import { TextArea } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { moderationStyles as styles } from '../../../styles';
import type { ModerationCatalogModel } from '../../../types';
import type { ModerationConfigView } from '../../draft';
import Field from '../../Field';
import ModelSelect from '../../ModelSelect';

export interface LlmJudgeFieldsProps {
  catalog: readonly ModerationCatalogModel[];
  classifier: ModerationConfigView['classifier'];
  disabled: boolean;
  patchClassifier: (patch: Partial<ModerationConfigView['classifier']>) => void;
}

export const LlmJudgeFields = memo<LlmJudgeFieldsProps>(
  ({ catalog, classifier, disabled, patchClassifier }) => {
    const { t } = useTranslation('admin');

    return (
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
    );
  },
);

LlmJudgeFields.displayName = 'ModerationLlmJudgeFields';
