'use client';

import { Flexbox, Input, InputNumber, InputPassword, Text, TextArea } from '@lobehub/ui';
import { Select, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminConnectorDraftValidation, EditableAdminConnectorDraft } from './controller';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    flex-direction: column;
    gap: 16px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;

    @media (width <= 800px) {
      grid-template-columns: 1fr;
    }
  `,
}));

interface ConnectorEditorFieldsProps {
  disabled?: boolean;
  draft: EditableAdminConnectorDraft;
  errors: AdminConnectorDraftValidation['errors'];
  onChange: <Key extends keyof EditableAdminConnectorDraft>(
    key: Key,
    value: EditableAdminConnectorDraft[Key],
  ) => void;
  onSecretChange: (secret: string) => void;
  secretConfigured: boolean;
  secretValue: string;
}

const ConnectorEditorFields = memo<ConnectorEditorFieldsProps>(
  ({ disabled, draft, errors, onChange, onSecretChange, secretConfigured, secretValue }) => {
    const { t } = useTranslation('admin');
    const error = (field: keyof EditableAdminConnectorDraft) =>
      errors[field] ? (
        <Text role={'alert'} type={'danger'}>
          {t(`connectorCatalog.validation.${errors[field]}` as never)}
        </Text>
      ) : null;

    return (
      <div className={styles.card}>
        <div className={styles.grid}>
          <div className={styles.field}>
            <Text strong>{t('connectorCatalog.editor.displayName')}</Text>
            <Input
              disabled={disabled}
              maxLength={200}
              value={draft.displayName}
              onChange={(event) => onChange('displayName', event.target.value)}
            />
            {error('displayName')}
          </div>
          <div className={styles.field}>
            <Text strong>{t('connectorCatalog.editor.endpoint')}</Text>
            <Input
              disabled={disabled}
              maxLength={4096}
              value={draft.endpoint}
              onChange={(event) => onChange('endpoint', event.target.value)}
            />
            {error('endpoint')}
          </div>
          <div className={styles.field}>
            <Text strong>{t('connectorCatalog.editor.credentialMode')}</Text>
            <Select
              disabled={disabled}
              value={draft.credentialMode}
              options={(['none', 'shared_service_account', 'per_user_oauth'] as const).map(
                (value) => ({
                  label: t(`connectorCatalog.credentialMode.${value}` as never),
                  value,
                }),
              )}
              onChange={(value) => onChange('credentialMode', value as typeof draft.credentialMode)}
            />
          </div>
          <div className={styles.field}>
            <Text strong>{t('connectorCatalog.editor.sort')}</Text>
            <InputNumber
              disabled={disabled}
              precision={0}
              value={draft.sort}
              onChange={(value) => onChange('sort', typeof value === 'number' ? value : 0)}
            />
          </div>
        </div>
        <div className={styles.field}>
          <Text strong>{t('connectorCatalog.editor.description')}</Text>
          <TextArea
            disabled={disabled}
            maxLength={4000}
            rows={3}
            value={draft.description}
            onChange={(event) => onChange('description', event.target.value)}
          />
        </div>
        <Flexbox horizontal align={'center'} gap={8}>
          <Switch
            checked={draft.enabled}
            disabled={disabled}
            onChange={(value) => onChange('enabled', value)}
          />
          <Text>{t('connectorCatalog.editor.enabled')}</Text>
        </Flexbox>

        {draft.credentialMode === 'per_user_oauth' ? (
          <>
            <Text strong>{t('connectorCatalog.editor.oauthSection')}</Text>
            <div className={styles.grid}>
              {(
                [
                  ['oauthIssuer', 'issuer'],
                  ['oauthAuthorizationEndpoint', 'authorizationEndpoint'],
                  ['oauthTokenEndpoint', 'tokenEndpoint'],
                  ['oauthClientId', 'clientId'],
                  ['oauthScopes', 'scopes'],
                ] as const
              ).map(([field, label]) => (
                <div className={styles.field} key={field}>
                  <Text strong>{t(`connectorCatalog.editor.${label}` as never)}</Text>
                  <Input
                    disabled={disabled}
                    value={draft[field]}
                    onChange={(event) => onChange(field, event.target.value)}
                  />
                  {error(field)}
                </div>
              ))}
            </div>
          </>
        ) : null}

        {draft.credentialMode !== 'none' ? (
          <div className={styles.field}>
            <Text strong>
              {t(
                draft.credentialMode === 'per_user_oauth'
                  ? 'connectorCatalog.editor.oauthClientSecret'
                  : 'connectorCatalog.editor.sharedSecret',
              )}
            </Text>
            <InputPassword
              disabled={disabled}
              value={secretValue}
              placeholder={t(
                secretConfigured
                  ? 'connectorCatalog.editor.secretKeepPlaceholder'
                  : 'connectorCatalog.editor.secretMissingPlaceholder',
              )}
              onChange={(event) => onSecretChange(event.target.value)}
            />
            <Text type={'secondary'}>{t('connectorCatalog.editor.secretNeverReturned')}</Text>
          </div>
        ) : null}
      </div>
    );
  },
);

ConnectorEditorFields.displayName = 'AdminConnectorEditorFields';

export default ConnectorEditorFields;
