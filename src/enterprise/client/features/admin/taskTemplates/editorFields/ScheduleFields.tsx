'use client';

import { Text } from '@lobehub/ui';
import { Input, InputNumber, Segmented, Select } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  buildCronFromDraft,
  formatTaskTemplateSchedule,
  TASK_TEMPLATE_WEEKDAY_KEYS,
  type TaskTemplateSchedulePreset,
} from '../schedule';
import type { TaskTemplateFormErrors } from '../useTaskTemplateForm';
import { taskTemplateEditorStyles as styles } from './styles';
import type { TaskTemplateFieldSectionProps } from './types';

const PRESETS: TaskTemplateSchedulePreset[] = ['daily', 'weekdays', 'weekly', 'hourly', 'custom'];
const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12];

interface ScheduleFieldsProps extends TaskTemplateFieldSectionProps {
  errors: TaskTemplateFormErrors;
}

/** Preset picker plus the one row of controls the chosen preset actually needs. */
export const ScheduleFields = memo<ScheduleFieldsProps>(
  ({ dispatch, errors, id, state, submitting }) => {
    const { t, i18n } = useTranslation('admin');
    const cronPattern = buildCronFromDraft(state.schedule);

    return (
      <fieldset className={styles.field} style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend className={styles.label}>{t('taskTemplateCatalog.form.schedule')}</legend>
        <Segmented
          value={state.schedule.preset}
          options={PRESETS.map((preset) => ({
            label: t(`taskTemplateCatalog.form.preset.${preset}` as never),
            value: preset,
          }))}
          onChange={(value) =>
            dispatch({ type: 'setPreset', value: value as TaskTemplateSchedulePreset })
          }
        />
        <div className={styles.scheduleRow}>
          {state.schedule.preset === 'weekly' ? (
            <Select
              aria-label={t('taskTemplateCatalog.form.weekday')}
              disabled={submitting}
              style={{ minWidth: 140 }}
              value={String(state.schedule.weekday)}
              options={TASK_TEMPLATE_WEEKDAY_KEYS.map((key, index) => ({
                label: t(`taskTemplateCatalog.weekday.${key}` as never),
                value: String(index),
              }))}
              onChange={(value) =>
                dispatch({ type: 'setWeekday', value: Number.parseInt(String(value), 10) })
              }
            />
          ) : null}
          {state.schedule.preset === 'hourly' ? (
            <Select
              aria-label={t('taskTemplateCatalog.form.interval')}
              disabled={submitting}
              style={{ minWidth: 140 }}
              value={String(state.schedule.interval)}
              options={HOUR_INTERVALS.map((hours) => ({
                label: t('taskTemplateCatalog.schedule.hourlyEvery', { hours }),
                value: String(hours),
              }))}
              onChange={(value) =>
                dispatch({ type: 'setInterval', value: Number.parseInt(String(value), 10) })
              }
            />
          ) : null}
          {state.schedule.preset === 'custom' ? (
            <Input
              aria-describedby={id('cron-hint')}
              aria-invalid={Boolean(errors.cron)}
              aria-label={t('taskTemplateCatalog.form.cron')}
              disabled={submitting}
              id={id('cron')}
              maxLength={120}
              placeholder="0 9 * * *"
              style={{ minWidth: 220 }}
              value={state.schedule.pattern}
              onChange={(event) => dispatch({ type: 'setCronPattern', value: event.target.value })}
            />
          ) : (
            <>
              <label className={styles.label} htmlFor={id('hour')}>
                {t('taskTemplateCatalog.form.hour')}
              </label>
              <InputNumber
                disabled={submitting || state.schedule.preset === 'hourly'}
                id={id('hour')}
                max={23}
                min={0}
                style={{ width: 88 }}
                value={state.schedule.hour}
                onChange={(value) => dispatch({ type: 'setHour', value: Number(value ?? 0) })}
              />
              <label className={styles.label} htmlFor={id('minute')}>
                {t('taskTemplateCatalog.form.minute')}
              </label>
              <InputNumber
                disabled={submitting}
                id={id('minute')}
                max={59}
                min={0}
                style={{ width: 88 }}
                value={state.schedule.minute}
                onChange={(value) => dispatch({ type: 'setMinute', value: Number(value ?? 0) })}
              />
            </>
          )}
        </div>
        {state.schedule.preset === 'custom' ? (
          <Text id={id('cron-hint')} type="secondary">
            {t('taskTemplateCatalog.form.cronHint')}
          </Text>
        ) : null}
        {errors.cron ? (
          <Text className={styles.error} role="alert">
            {errors.cron}
          </Text>
        ) : (
          <Text type="secondary">
            {t('taskTemplateCatalog.form.preview', {
              summary: formatTaskTemplateSchedule(
                cronPattern,
                t as never,
                i18n.resolvedLanguage || i18n.language,
              ),
            })}
          </Text>
        )}
      </fieldset>
    );
  },
);

ScheduleFields.displayName = 'AdminTaskTemplateScheduleFields';
