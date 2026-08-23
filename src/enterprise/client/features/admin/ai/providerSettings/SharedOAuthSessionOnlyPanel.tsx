'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css, cssVar }) => ({
  meta: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

interface SharedOAuthSessionOnlyPanelProps {
  onCancel: () => void;
  onSubmit: () => void;
  sessionFields: ReactNode;
  sessionSteps: ReactNode;
  submitDisabled: boolean;
  submitting?: boolean;
}

/**
 * Web-session-only providers get ONE route and it is the primary one. The authorization
 * page is not merely demoted here: it signs the operator into a different product, and
 * the server refuses the exchange — so offering it would be offering a dead end.
 */
const SharedOAuthSessionOnlyPanel = memo<SharedOAuthSessionOnlyPanelProps>(
  ({ onCancel, onSubmit, sessionFields, sessionSteps, submitDisabled, submitting }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox gap={12}>
        <Flexbox gap={4}>
          <Text weight={600}>{t('aiProviderSettings.sharedOAuth.paste.sessionOnlyTitle')}</Text>
          <Text className={styles.meta}>
            {t('aiProviderSettings.sharedOAuth.paste.sessionOnlyDesc')}
          </Text>
        </Flexbox>
        {/* Above the box, because it is what to do BEFORE there is anything to paste. */}
        {sessionSteps}
        <Flexbox gap={8}>{sessionFields}</Flexbox>
        <Flexbox horizontal gap={8}>
          <Button
            disabled={submitDisabled}
            loading={submitting}
            type={'primary'}
            onClick={onSubmit}
          >
            {t('aiProviderSettings.sharedOAuth.paste.submit')}
          </Button>
          <Button onClick={onCancel}>{t('aiProviderSettings.sharedOAuth.cancel')}</Button>
        </Flexbox>
      </Flexbox>
    );
  },
);

SharedOAuthSessionOnlyPanel.displayName = 'AdminSharedOAuthSessionOnlyPanel';

export default SharedOAuthSessionOnlyPanel;
