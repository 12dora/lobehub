'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button, Switch, useModalContext } from '@lobehub/ui/base-ui';
import { memo, useId } from 'react';
import { useTranslation } from 'react-i18next';

import {
  CatalogFields,
  ConnectorFields,
  ScheduleFields,
  taskTemplateEditorStyles as styles,
  TextFields,
} from './editorFields';
import type { TaskTemplateFormAction, TaskTemplateFormState } from './useTaskTemplateForm';

export interface TaskTemplateEditorFormProps {
  /** Set when another administrator changed the row while this editor was open. */
  conflict?: boolean;
  dispatch: (action: TaskTemplateFormAction) => void;
  errors: Partial<Record<'connectors' | 'cron' | 'instruction' | 'title', string>>;
  mode: 'create' | 'edit';
  onReload?: () => void;
  onSubmit: () => void;
  /** Set when the reload itself failed, or the row turned out to be gone. */
  reloadError?: string;
  reloading?: boolean;
  state: TaskTemplateFormState;
  submitError?: string;
  submitting: boolean;
  valid: boolean;
}

/** Presentational editor body — every value comes from `useTaskTemplateForm`. */
const TaskTemplateEditorForm = memo<TaskTemplateEditorFormProps>(
  ({
    conflict,
    dispatch,
    errors,
    onReload,
    onSubmit,
    reloadError,
    reloading,
    state,
    submitError,
    submitting,
    valid,
  }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const fieldId = useId();
    const id = (name: string) => `${fieldId}-${name}`;

    return (
      <form
        className={styles.body}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {conflict ? (
          <Alert
            showIcon
            description={reloadError}
            message={t('taskTemplateCatalog.form.conflict')}
            type={reloadError ? 'error' : 'warning'}
            action={
              onReload ? (
                <Button htmlType="button" loading={reloading} size="small" onClick={onReload}>
                  {t('taskTemplateCatalog.form.conflictReload')}
                </Button>
              ) : undefined
            }
          />
        ) : null}

        <TextFields
          dispatch={dispatch}
          errors={errors}
          id={id}
          state={state}
          submitting={submitting}
        />

        <ScheduleFields
          dispatch={dispatch}
          errors={errors}
          id={id}
          state={state}
          submitting={submitting}
        />

        <CatalogFields dispatch={dispatch} id={id} state={state} submitting={submitting} />

        <ConnectorFields
          dispatch={dispatch}
          errors={errors}
          state={state}
          submitting={submitting}
        />

        {/* Display order is not a field here — it is dragged on the list page. */}
        <div className={styles.field}>
          <label className={styles.label} htmlFor={id('enabled')}>
            {t('taskTemplateCatalog.form.enabled')}
          </label>
          <Flexbox horizontal>
            <Switch
              checked={state.enabled}
              disabled={submitting}
              id={id('enabled')}
              onChange={(value) => dispatch({ type: 'setEnabled', value })}
            />
          </Flexbox>
        </div>

        {submitError ? (
          <Text className={styles.error} role="alert">
            {submitError}
          </Text>
        ) : null}

        <div className={styles.footer}>
          <Button disabled={submitting} htmlType="button" onClick={close}>
            {t('taskTemplateCatalog.form.cancel')}
          </Button>
          <Button disabled={!valid} htmlType="submit" loading={submitting} type="primary">
            {t('taskTemplateCatalog.form.submit')}
          </Button>
        </div>
      </form>
    );
  },
);

TaskTemplateEditorForm.displayName = 'AdminTaskTemplateEditorForm';

export default TaskTemplateEditorForm;
