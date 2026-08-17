'use client';

import { CopyButton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css }) => ({
  credentialRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    padding-block: 6px;
    padding-inline: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
  `,
  credentialValue: css`
    font-family: ${cssVar.fontFamilyCode};
    overflow-wrap: anywhere;
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  footer: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  `,
  title: css`
    margin: 0;
    font-size: ${cssVar.fontSizeLG};
    font-weight: 600;
  `,
  warning: css`
    color: ${cssVar.colorWarningText};
  `,
}));

export interface CreateUserCredentialsPanelProps {
  credentials: { email: string; password: string };
  onDone: () => void;
}

export const CreateUserCredentialsPanel = memo<CreateUserCredentialsPanelProps>(
  ({ credentials, onDone }) => {
    const { t } = useTranslation('admin');

    return (
      <>
        <Text as="h2" className={styles.title}>
          {t('users.modals.create.successTitle')}
        </Text>
        <Text className={styles.warning} role="alert">
          {t('users.modals.create.successWarning')}
        </Text>
        <div className={styles.field}>
          <Text strong>{t('users.modals.create.credentialEmail')}</Text>
          <div className={styles.credentialRow}>
            <Text className={styles.credentialValue}>{credentials.email}</Text>
            <CopyButton
              content={credentials.email}
              size="small"
              title={t('users.modals.create.copy')}
            />
          </div>
        </div>
        <div className={styles.field}>
          <Text strong>{t('users.modals.create.credentialPassword')}</Text>
          <div className={styles.credentialRow}>
            <Text className={styles.credentialValue} data-testid="created-user-password">
              {credentials.password}
            </Text>
            <CopyButton
              content={credentials.password}
              size="small"
              title={t('users.modals.create.copy')}
            />
          </div>
        </div>
        <div className={styles.footer}>
          <Button type="primary" onClick={onDone}>
            {t('users.modals.create.done')}
          </Button>
        </div>
      </>
    );
  },
);

CreateUserCredentialsPanel.displayName = 'CreateUserCredentialsPanel';
