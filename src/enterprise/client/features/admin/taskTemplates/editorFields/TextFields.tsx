'use client';

import { Text } from '@lobehub/ui';
import { Input, TextArea } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { TaskTemplateFormErrors } from '../useTaskTemplateForm';
import { taskTemplateEditorStyles as styles } from './styles';
import type { TaskTemplateFieldSectionProps } from './types';

interface TextFieldsProps extends TaskTemplateFieldSectionProps {
  errors: TaskTemplateFormErrors;
}

/** Title, description and instruction — the free-text half of the template. */
export const TextFields = memo<TextFieldsProps>(({ dispatch, errors, id, state, submitting }) => {
  const { t } = useTranslation('admin');

  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={id('title')}>
          {t('taskTemplateCatalog.form.title')}
        </label>
        <Input
          aria-describedby={errors.title ? id('title-error') : undefined}
          aria-invalid={Boolean(errors.title)}
          disabled={submitting}
          id={id('title')}
          maxLength={200}
          value={state.title}
          onChange={(event) =>
            dispatch({ field: 'title', type: 'setText', value: event.target.value })
          }
        />
        {errors.title ? (
          <Text className={styles.error} id={id('title-error')} role="alert">
            {errors.title}
          </Text>
        ) : null}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={id('description')}>
          {t('taskTemplateCatalog.form.description')}
        </label>
        <TextArea
          disabled={submitting}
          id={id('description')}
          maxLength={1000}
          rows={2}
          value={state.description}
          onChange={(event) =>
            dispatch({ field: 'description', type: 'setText', value: event.target.value })
          }
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={id('instruction')}>
          {t('taskTemplateCatalog.form.instruction')}
        </label>
        <TextArea
          aria-describedby={errors.instruction ? id('instruction-error') : id('instruction-hint')}
          aria-invalid={Boolean(errors.instruction)}
          disabled={submitting}
          id={id('instruction')}
          maxLength={8000}
          rows={5}
          value={state.instruction}
          onChange={(event) =>
            dispatch({ field: 'instruction', type: 'setText', value: event.target.value })
          }
        />
        <Text id={id('instruction-hint')} type="secondary">
          {t('taskTemplateCatalog.form.instructionHint')}
        </Text>
        {errors.instruction ? (
          <Text className={styles.error} id={id('instruction-error')} role="alert">
            {errors.instruction}
          </Text>
        ) : null}
      </div>
    </>
  );
});

TextFields.displayName = 'AdminTaskTemplateTextFields';
