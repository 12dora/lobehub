'use client';

import { Alert, Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { StoredAlertMessageKey } from './sharedOAuthConnectRoutes';

interface SharedOAuthSuccessPanelProps {
  enforcementHint: ReactNode;
  /** What the stored credential actually means to members right now. */
  messageKey: StoredAlertMessageKey;
  onDone: () => void;
}

/** The view right after the credential landed: what it means, and the way out of the flow. */
const SharedOAuthSuccessPanel = memo<SharedOAuthSuccessPanelProps>(
  ({ enforcementHint, messageKey, onDone }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox gap={12}>
        <Alert message={t(messageKey)} type={'success'} />
        {enforcementHint}
        <Flexbox horizontal>
          <Button onClick={onDone}>{t('aiProviderSettings.sharedOAuth.done')}</Button>
        </Flexbox>
      </Flexbox>
    );
  },
);

SharedOAuthSuccessPanel.displayName = 'AdminSharedOAuthSuccessPanel';

export default SharedOAuthSuccessPanel;
