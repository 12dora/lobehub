'use client';

import { INTEREST_AREA_KEYS, TASK_TEMPLATE_CATEGORIES, TASK_TEMPLATE_ICONS } from '@lobechat/const';
import { Alert, Flexbox, Text } from '@lobehub/ui';
import {
  Button,
  Input,
  InputNumber,
  Segmented,
  Select,
  Switch,
  TextArea,
  useModalContext,
} from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useId } from 'react';
import { useTranslation } from 'react-i18next';

import { TASK_TEMPLATE_MAX_CONNECTORS } from '@/server/enterprise/contracts/adminTaskTemplates';

import {
  buildConnectorOptions,
  decodeConnectorValue,
  encodeConnectorValue,
} from './connectorCatalog';
import {
  buildCronFromDraft,
  formatTaskTemplateSchedule,
  TASK_TEMPLATE_WEEKDAY_KEYS,
  type TaskTemplateSchedulePreset,
} from './schedule';
import type { TaskTemplateFormAction, TaskTemplateFormState } from './useTaskTemplateForm';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
  `,
  connectorRow: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 8px;
    align-items: center;

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  `,
  footer: css`
    display: flex;
    gap: 8px;
    justify-content: end;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
  label: css`
    font-weight: 500;
  `,
  scheduleRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
}));

const PRESETS: TaskTemplateSchedulePreset[] = ['daily', 'weekdays', 'weekly', 'hourly', 'custom'];
const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12];

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
    const { t, i18n } = useTranslation('admin');
    const { close } = useModalContext();
    const cronPattern = buildCronFromDraft(state.schedule);
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
                onChange={(event) =>
                  dispatch({ type: 'setCronPattern', value: event.target.value })
                }
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

        <div className={styles.grid}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={id('category')}>
              {t('taskTemplateCatalog.form.category')}
            </label>
            <Select
              aria-label={t('taskTemplateCatalog.form.category')}
              disabled={submitting}
              id={id('category')}
              value={state.category}
              options={TASK_TEMPLATE_CATEGORIES.map((category) => ({
                label: t(`taskTemplateCatalog.category.${category}` as never),
                value: category,
              }))}
              onChange={(value) => dispatch({ type: 'setCategory', value: String(value) })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={id('icon')}>
              {t('taskTemplateCatalog.form.icon')}
            </label>
            <Select
              aria-label={t('taskTemplateCatalog.form.icon')}
              disabled={submitting}
              id={id('icon')}
              value={state.icon ?? ''}
              options={[
                { label: t('taskTemplateCatalog.form.iconNone'), value: '' },
                ...TASK_TEMPLATE_ICONS.map((icon) => ({ label: icon, value: icon })),
              ]}
              onChange={(value) => dispatch({ type: 'setIcon', value: String(value) || null })}
            />
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={id('interests')}>
            {t('taskTemplateCatalog.form.interests')}
          </label>
          <Select
            aria-label={t('taskTemplateCatalog.form.interests')}
            disabled={submitting}
            id={id('interests')}
            mode="multiple"
            placeholder={t('taskTemplateCatalog.form.interestsPlaceholder')}
            value={state.interests}
            options={INTEREST_AREA_KEYS.map((interest) => ({
              label: t(`taskTemplateCatalog.interest.${interest}` as never),
              value: interest,
            }))}
            onChange={(value) =>
              dispatch({ type: 'setInterests', value: Array.isArray(value) ? value : [] })
            }
          />
        </div>

        <fieldset className={styles.field} style={{ border: 'none', margin: 0, padding: 0 }}>
          <legend className={styles.label}>{t('taskTemplateCatalog.form.connectors')}</legend>
          {state.connectors.length === 0 ? (
            <Text type="secondary">{t('taskTemplateCatalog.form.connectorEmpty')}</Text>
          ) : null}
          {state.connectors.map((connector, index) => (
            <div className={styles.connectorRow} key={index}>
              {/* Catalog-backed: an identifier outside these lists makes the user-side card
                  disappear silently, so it must not be typeable. */}
              <Select
                aria-label={t('taskTemplateCatalog.form.connectorIdentifier')}
                disabled={submitting}
                placeholder={t('taskTemplateCatalog.form.connectorPlaceholder')}
                value={connector.identifier ? encodeConnectorValue(connector) : undefined}
                options={buildConnectorOptions(connector, (identifier) =>
                  t('taskTemplateCatalog.form.connectorRetired', { identifier }),
                )}
                onChange={(value) => {
                  const decoded = decodeConnectorValue(String(value ?? ''));
                  if (decoded) dispatch({ index, type: 'setConnector', value: decoded });
                }}
              />
              <label>
                <Switch
                  checked={connector.required}
                  disabled={submitting}
                  onChange={(value) => dispatch({ index, type: 'setConnectorRequired', value })}
                />{' '}
                {t('taskTemplateCatalog.form.connectorRequired')}
              </label>
              <Button
                disabled={submitting}
                htmlType="button"
                size="small"
                onClick={() => dispatch({ index, type: 'removeConnector' })}
              >
                {t('taskTemplateCatalog.form.connectorRemove')}
              </Button>
            </div>
          ))}
          <Flexbox horizontal>
            <Button
              // The API contract caps the array — do not offer a row the server would reject.
              disabled={submitting || state.connectors.length >= TASK_TEMPLATE_MAX_CONNECTORS}
              htmlType="button"
              size="small"
              onClick={() => dispatch({ type: 'addConnector' })}
            >
              {t('taskTemplateCatalog.form.connectorAdd')}
            </Button>
          </Flexbox>
          {errors.connectors ? (
            <Text className={styles.error} role="alert">
              {errors.connectors}
            </Text>
          ) : null}
        </fieldset>

        <div className={styles.grid}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={id('sortOrder')}>
              {t('taskTemplateCatalog.form.sortOrder')}
            </label>
            <InputNumber
              aria-describedby={id('sortOrder-hint')}
              disabled={submitting}
              id={id('sortOrder')}
              max={9999}
              min={0}
              value={state.sortOrder}
              onChange={(value) => dispatch({ type: 'setSortOrder', value: Number(value ?? 0) })}
            />
            <Text id={id('sortOrder-hint')} type="secondary">
              {t('taskTemplateCatalog.form.sortOrderHint')}
            </Text>
          </div>
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
