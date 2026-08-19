'use client';

import { Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

interface SharedOAuthSessionFixActionsProps {
  connectDisabled?: boolean;
  onConnect: () => void;
  onConnectWithSession: () => void;
  webSessionOnly: boolean;
}

/**
 * The cheaper session paste plus the optional renewable reconnect. Paste is the primary
 * action: it is one paste and no browser round trip. A web-session-only provider must not
 * offer the authorization page its own server refuses to complete.
 */
const SharedOAuthSessionFixActions = memo<SharedOAuthSessionFixActionsProps>(
  ({ connectDisabled, onConnect, onConnectWithSession, webSessionOnly }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox horizontal gap={8}>
        <Button
          disabled={connectDisabled}
          size={'small'}
          type={'primary'}
          onClick={onConnectWithSession}
        >
          {t('aiProviderSettings.sharedOAuth.paste.pasteSession')}
        </Button>
        {!webSessionOnly && (
          <Button disabled={connectDisabled} size={'small'} onClick={onConnect}>
            {t('aiProviderSettings.sharedOAuth.paste.reconnectRenewable')}
          </Button>
        )}
      </Flexbox>
    );
  },
);

SharedOAuthSessionFixActions.displayName = 'AdminSharedOAuthSessionFixActions';

export default SharedOAuthSessionFixActions;
