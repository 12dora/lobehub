'use client';

import { Input, Text, TextArea } from '@lobehub/ui';
import { Button, createModal, Select, Switch, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import i18next from 'i18next';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  type AdminReauthAuthMethod,
  withAdminReauthRetry,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { buildApplyImmediateVersionPayload } from './controller';
import type { AdminSkillCreateInput } from './types';

type ApplyImmediateVersionPayload = NonNullable<
  ReturnType<typeof buildApplyImmediateVersionPayload>
>;

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

/** Create identity + optional version payload for applyImmediate create. */
export type AdminSkillCreateWithVersionInput = AdminSkillCreateInput & {
  version?: ApplyImmediateVersionPayload;
};

export interface CreateSkillModalProps {
  authMethod?: AdminReauthAuthMethod;
  onSubmit: (input: AdminSkillCreateWithVersionInput) => Promise<void>;
  /**
   * When true, collect version content so create can publish immediately
   * (admin AI settings page). Default false preserves advanced-catalog behavior.
   */
  withVersionPayload?: boolean;
}

export const runCreateSkillSubmission = async (
  input: AdminSkillCreateWithVersionInput,
  onSubmit: CreateSkillModalProps['onSubmit'],
  options: {
    authMethod?: AdminReauthAuthMethod;
    runReauth?: (
      commit: () => Promise<void>,
      options: { authMethod: AdminReauthAuthMethod },
    ) => Promise<void>;
  } = {},
) => {
  const frozen = structuredClone(input);
  const commit = () => onSubmit(structuredClone(frozen));
  if (!frozen.allowBuiltinOverride) return commit();
  return (options.runReauth ?? withAdminReauthRetry)(commit, {
    authMethod: options.authMethod ?? null,
  });
};

const CreateSkillContent = memo<CreateSkillModalProps>(
  ({ authMethod, onSubmit, withVersionPayload = false }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const [skillKey, setSkillKey] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [description, setDescription] = useState('');
    const [distribution, setDistribution] =
      useState<AdminSkillCreateInput['distribution']>('default');
    const [enabled, setEnabled] = useState(true);
    const [allowBuiltinOverride, setAllowBuiltinOverride] = useState(false);
    const [reason, setReason] = useState('');
    const [version, setVersion] = useState('1.0.0');
    const [content, setContent] = useState('# Platform skill\n');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
      const normalizedKey = skillKey.trim();
      const normalizedName = displayName.trim();
      const normalizedReason = reason.trim();
      if (!normalizedKey || !normalizedName || !normalizedReason) {
        setError(t('skillCatalog.form.required'));
        return;
      }
      const input: AdminSkillCreateWithVersionInput = {
        allowBuiltinOverride,
        description: description.trim() || null,
        displayName: normalizedName,
        distribution,
        enabled,
        reason: normalizedReason,
        skillKey: normalizedKey,
      };
      if (withVersionPayload) {
        const versionPayload = buildApplyImmediateVersionPayload({
          content,
          description: description.trim() || null,
          displayName: normalizedName,
          version,
        });
        if (!versionPayload) {
          setError(
            t('aiSkillSettings.create.versionRequired', {
              defaultValue: 'Version and skill content are required to list a skill.',
            }),
          );
          return;
        }
        input.version = versionPayload;
      }
      setLoading(true);
      setError(null);
      try {
        await runCreateSkillSubmission(input, onSubmit, { authMethod });
        close();
      } catch (cause) {
        const mapped = mapEnterpriseError(cause);
        setError(
          mapped
            ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
            : t('skillCatalog.errors.generic'),
        );
      } finally {
        setLoading(false);
      }
    };

    return (
      <div className={styles.body}>
        <Text type="secondary">{t('skillCatalog.create.desc')}</Text>
        <div className={styles.grid}>
          <div className={styles.field}>
            <Text strong>{t('skillCatalog.detail.identity.key')}</Text>
            <Input
              disabled={loading}
              maxLength={128}
              value={skillKey}
              onChange={(e) => setSkillKey(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <Text strong>{t('skillCatalog.form.displayName')}</Text>
            <Input
              disabled={loading}
              maxLength={200}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
        </div>
        <div className={styles.field}>
          <Text strong>{t('skillCatalog.form.description')}</Text>
          <TextArea
            disabled={loading}
            maxLength={4000}
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <Text strong>{t('skillCatalog.detail.identity.distribution')}</Text>
          <Select
            disabled={loading}
            value={distribution}
            options={(['default', 'mandatory', 'optional'] as const).map((value) => ({
              label: t(`skillCatalog.distribution.${value}` as never),
              value,
            }))}
            onChange={(value) => setDistribution(value as AdminSkillCreateInput['distribution'])}
          />
        </div>
        <label>
          <Switch checked={enabled} disabled={loading} onChange={setEnabled} />{' '}
          {t('skillCatalog.form.enabled')}
        </label>
        <label>
          <Switch
            checked={allowBuiltinOverride}
            disabled={loading}
            onChange={setAllowBuiltinOverride}
          />{' '}
          {t('skillCatalog.form.allowBuiltinOverride')}
        </label>
        {allowBuiltinOverride ? (
          <Text type="warning">{t('skillCatalog.form.builtinOverrideWarning')}</Text>
        ) : null}
        {withVersionPayload ? (
          <>
            <div className={styles.field}>
              <Text strong>{t('aiSkillSettings.create.version', { defaultValue: 'Version' })}</Text>
              <Input
                disabled={loading}
                maxLength={64}
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <Text strong>
                {t('aiSkillSettings.create.content', {
                  defaultValue: 'Skill content (markdown)',
                })}
              </Text>
              <TextArea
                disabled={loading}
                rows={8}
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            </div>
          </>
        ) : null}
        <div className={styles.field}>
          <Text strong>{t('skillCatalog.form.reason')}</Text>
          <TextArea
            disabled={loading}
            maxLength={2000}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
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
            {withVersionPayload
              ? t('aiSkillSettings.actions.create', { defaultValue: 'List skill' })
              : t('skillCatalog.create.submit')}
          </Button>
        </div>
      </div>
    );
  },
);

CreateSkillContent.displayName = 'AdminCreateSkillContent';

export const openCreateSkillModal = (props: CreateSkillModalProps) =>
  createModal({
    content: <CreateSkillContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t('skillCatalog.create.title', { ns: 'admin' }),
    width: 'min(94vw, 720px)',
  });
