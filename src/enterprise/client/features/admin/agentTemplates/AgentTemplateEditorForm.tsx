'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button, Input, Select, Switch, TextArea, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useId } from 'react';
import { useTranslation } from 'react-i18next';

import EmojiPicker from '@/components/EmojiPicker';
import { DEFAULT_AVATAR } from '@/const/meta';
import BackgroundSwatches from '@/features/AgentSetting/AgentMeta/BackgroundSwatches';
import {
  AGENT_TEMPLATE_DESCRIPTION_MAX,
  AGENT_TEMPLATE_SYSTEM_ROLE_MAX,
  AGENT_TEMPLATE_TITLE_MAX,
} from '@/server/enterprise/contracts/adminAgentTemplates';

import type { AgentTemplateFormAction, AgentTemplateFormState } from './useAgentTemplateForm';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
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
  /** Avatar sits beside the name/colour column, exactly like the platform-agent editor. */
  identityRow: css`
    display: flex;
    gap: 12px;
    align-items: flex-start;

    @media (width <= 640px) {
      flex-direction: column;
    }
  `,
  identityName: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;

    min-width: 0;
  `,
  label: css`
    font-weight: 500;
  `,
}));

export interface AgentTemplateEditorFormProps {
  /** Set when another administrator changed the row while this editor was open. */
  conflict?: boolean;
  dispatch: (action: AgentTemplateFormAction) => void;
  errors: Partial<Record<'systemRole' | 'tags' | 'title', string>>;
  mode: 'create' | 'edit';
  onReload?: () => void;
  onSubmit: () => void;
  /** Set when the reload itself failed, or the row turned out to be gone. */
  reloadError?: string;
  reloading?: boolean;
  state: AgentTemplateFormState;
  submitError?: string;
  submitting: boolean;
  valid: boolean;
}

/** Presentational editor body — every value comes from `useAgentTemplateForm`. */
const AgentTemplateEditorForm = memo<AgentTemplateEditorFormProps>(
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
    const background = state.backgroundColor ?? undefined;

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
            message={t('agentTemplateCatalog.form.conflict')}
            type={reloadError ? 'error' : 'warning'}
            action={
              onReload ? (
                <Button htmlType="button" loading={reloading} size="small" onClick={onReload}>
                  {t('agentTemplateCatalog.form.conflictReload')}
                </Button>
              ) : undefined
            }
          />
        ) : null}

        <div className={styles.identityRow}>
          <div className={styles.field}>
            <span className={styles.label}>{t('agentTemplateCatalog.form.avatar')}</span>
            <EmojiPicker
              background={background}
              size={48}
              // Display-only fallback: an unset avatar must not render as the text "NU"
              // (`String(null)`); the platform default stays out of the persisted row.
              value={state.avatar ?? DEFAULT_AVATAR}
              onChange={(next: string) => dispatch({ type: 'setAvatar', value: next || null })}
            />
          </div>

          {/* One column: the swatch strip is part of the title box, ending where it ends. */}
          <div className={styles.identityName}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={id('title')}>
                {t('agentTemplateCatalog.form.title')}
              </label>
              <Input
                aria-describedby={errors.title ? id('title-error') : undefined}
                aria-invalid={Boolean(errors.title)}
                disabled={submitting}
                id={id('title')}
                maxLength={AGENT_TEMPLATE_TITLE_MAX}
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

            <div aria-label={t('agentTemplateCatalog.form.backgroundColor')} role="group">
              <BackgroundSwatches
                value={background}
                onChange={(next) => dispatch({ type: 'setBackgroundColor', value: next || null })}
              />
            </div>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={id('description')}>
            {t('agentTemplateCatalog.form.description')}
          </label>
          <TextArea
            aria-describedby={id('description-hint')}
            disabled={submitting}
            id={id('description')}
            maxLength={AGENT_TEMPLATE_DESCRIPTION_MAX}
            rows={2}
            value={state.description}
            onChange={(event) =>
              dispatch({ field: 'description', type: 'setText', value: event.target.value })
            }
          />
          <Text id={id('description-hint')} type="secondary">
            {t('agentTemplateCatalog.form.descriptionHint')}
          </Text>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={id('systemRole')}>
            {t('agentTemplateCatalog.form.systemRole')}
          </label>
          <TextArea
            aria-describedby={errors.systemRole ? id('systemRole-error') : id('systemRole-hint')}
            aria-invalid={Boolean(errors.systemRole)}
            disabled={submitting}
            id={id('systemRole')}
            maxLength={AGENT_TEMPLATE_SYSTEM_ROLE_MAX}
            rows={6}
            value={state.systemRole}
            onChange={(event) =>
              dispatch({ field: 'systemRole', type: 'setText', value: event.target.value })
            }
          />
          <Text id={id('systemRole-hint')} type="secondary">
            {t('agentTemplateCatalog.form.systemRoleHint')}
          </Text>
          {errors.systemRole ? (
            <Text className={styles.error} id={id('systemRole-error')} role="alert">
              {errors.systemRole}
            </Text>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={id('tags')}>
            {t('agentTemplateCatalog.form.tags')}
          </label>
          <Select
            allowClear
            aria-label={t('agentTemplateCatalog.form.tags')}
            disabled={submitting}
            id={id('tags')}
            mode="tags"
            options={state.tags.map((tag) => ({ label: tag, value: tag }))}
            placeholder={t('agentTemplateCatalog.form.tagsPlaceholder')}
            tokenSeparators={[',']}
            value={state.tags}
            onChange={(next) =>
              dispatch({
                type: 'setTags',
                value: Array.isArray(next) ? next.map(String) : next ? [String(next)] : [],
              })
            }
          />
          {errors.tags ? (
            <Text className={styles.error} role="alert">
              {errors.tags}
            </Text>
          ) : null}
        </div>

        {/* Display order is not a field here — it is dragged on the list page. */}
        <div className={styles.field}>
          <label className={styles.label} htmlFor={id('enabled')}>
            {t('agentTemplateCatalog.form.enabled')}
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
            {t('agentTemplateCatalog.form.cancel')}
          </Button>
          <Button disabled={!valid} htmlType="submit" loading={submitting} type="primary">
            {t('agentTemplateCatalog.form.submit')}
          </Button>
        </div>
      </form>
    );
  },
);

AgentTemplateEditorForm.displayName = 'AdminAgentTemplateEditorForm';

export default AgentTemplateEditorForm;
