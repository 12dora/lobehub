'use client';

import { INTEREST_AREA_KEYS, TASK_TEMPLATE_CATEGORIES, TASK_TEMPLATE_ICONS } from '@lobechat/const';
import { Select } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { taskTemplateEditorStyles as styles } from './styles';
import type { TaskTemplateFieldSectionProps } from './types';

/** Category, icon and interest areas — the catalog metadata the user-side cards read. */
export const CatalogFields = memo<TaskTemplateFieldSectionProps>(
  ({ dispatch, id, state, submitting }) => {
    const { t } = useTranslation('admin');

    return (
      <>
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
      </>
    );
  },
);

CatalogFields.displayName = 'AdminTaskTemplateCatalogFields';
