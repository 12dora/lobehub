'use client';

import { Input, Text, TextArea } from '@lobehub/ui';
import { Button, createModal, Select, Switch, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import i18next from 'i18next';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import type { AdminSkillCreateInput } from './types';
import { type AdminSkillCreateWithVersionInput, useCreateSkillForm } from './useCreateSkillForm';

export type { AdminSkillCreateWithVersionInput } from './useCreateSkillForm';
export { runCreateSkillSubmission } from './useCreateSkillForm';

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
}));

export interface CreateSkillModalProps {
  authMethod?: AdminReauthAuthMethod;
  onSubmit: (input: AdminSkillCreateWithVersionInput) => Promise<void>;
}

const CreateSkillContent = memo<CreateSkillModalProps>(({ authMethod, onSubmit }) => {
  const { t } = useTranslation('admin');
  const { close } = useModalContext();
  const { dispatch, state, submit } = useCreateSkillForm({
    authMethod,
    onSubmit,
    onSuccess: close,
  });
  const { loading, error } = state;

  return (
    <div className={styles.body}>
      <Text type="secondary">{t('skillCatalog.create.desc')}</Text>
      <div className={styles.grid}>
        <div className={styles.field}>
          <Text strong>{t('skillCatalog.detail.identity.key')}</Text>
          <Input
            disabled={loading}
            maxLength={128}
            value={state.skillKey}
            onChange={(e) =>
              dispatch({ field: 'skillKey', type: 'setField', value: e.target.value })
            }
          />
        </div>
        <div className={styles.field}>
          <Text strong>{t('skillCatalog.form.displayName')}</Text>
          <Input
            disabled={loading}
            maxLength={200}
            value={state.displayName}
            onChange={(e) =>
              dispatch({ field: 'displayName', type: 'setField', value: e.target.value })
            }
          />
        </div>
      </div>
      <div className={styles.field}>
        <Text strong>{t('skillCatalog.form.description')}</Text>
        <TextArea
          disabled={loading}
          maxLength={4000}
          rows={3}
          value={state.description}
          onChange={(e) =>
            dispatch({ field: 'description', type: 'setField', value: e.target.value })
          }
        />
      </div>
      <div className={styles.field}>
        <Text strong>{t('skillCatalog.detail.identity.distribution')}</Text>
        <Select
          disabled={loading}
          value={state.distribution}
          options={(['default', 'mandatory', 'optional'] as const).map((value) => ({
            label: t(`skillCatalog.distribution.${value}` as never),
            value,
          }))}
          onChange={(value) =>
            dispatch({
              type: 'setDistribution',
              value: value as AdminSkillCreateInput['distribution'],
            })
          }
        />
      </div>
      <label>
        <Switch
          checked={state.enabled}
          disabled={loading}
          onChange={(value) => dispatch({ type: 'setEnabled', value })}
        />{' '}
        {t('skillCatalog.form.enabled')}
      </label>
      <label>
        <Switch
          checked={state.allowBuiltinOverride}
          disabled={loading}
          onChange={(value) => dispatch({ type: 'setAllowBuiltinOverride', value })}
        />{' '}
        {t('skillCatalog.form.allowBuiltinOverride')}
      </label>
      {state.allowBuiltinOverride ? (
        <Text type="warning">{t('skillCatalog.form.builtinOverrideWarning')}</Text>
      ) : null}
      {error ? (
        <Text className={styles.error} role="alert">
          {error}
        </Text>
      ) : null}
      <div className={styles.footer}>
        <Button disabled={loading} onClick={close}>
          {t('users.modals.cancel')}
        </Button>
        <Button loading={loading} type="primary" onClick={() => void submit()}>
          {t('skillCatalog.create.submit')}
        </Button>
      </div>
    </div>
  );
});

CreateSkillContent.displayName = 'AdminCreateSkillContent';

export const openCreateSkillModal = (props: CreateSkillModalProps) =>
  createModal({
    content: <CreateSkillContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t('skillCatalog.create.title', { ns: 'admin' }),
    width: 'min(94vw, 720px)',
  });
