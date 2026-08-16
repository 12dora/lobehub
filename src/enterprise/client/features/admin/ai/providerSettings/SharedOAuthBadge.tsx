'use client';

import { Flexbox, Icon, Tag, Tooltip } from '@lobehub/ui';
import { CheckCircle2Icon, TriangleAlertIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

interface SharedOAuthBadgeProps {
  connected: boolean;
  needsReauth: boolean;
  reauthDetail: string;
  visible: boolean;
}

const SharedOAuthBadge = memo<SharedOAuthBadgeProps>(
  ({ connected, needsReauth, reauthDetail, visible }) => {
    const { t } = useTranslation('admin');

    // Never claim a state we have not read yet: no badge until the status resolves.
    if (!visible) return null;
    /**
     * Three states, not two: "never connected" and "connected but no longer accepted" used to
     * collapse into one grey 未连接 tag (or, worse, into a green 已连接 one), which is exactly
     * how an operator ended up looking at a healthy card while members were told to reconnect.
     * The reason and the time it was observed ride in the tooltip so the tag stays one word.
     */
    if (needsReauth)
      return (
        <Tooltip title={reauthDetail}>
          <Tag color={'warning'}>
            <Flexbox horizontal align={'center'} gap={4}>
              <Icon icon={TriangleAlertIcon} size={12} />
              {t('aiProviderSettings.sharedOAuth.needsReauth')}
            </Flexbox>
          </Tag>
        </Tooltip>
      );
    if (!connected) return <Tag>{t('aiProviderSettings.sharedOAuth.notConnected')}</Tag>;
    return (
      <Tag color={'success'}>
        <Flexbox horizontal align={'center'} gap={4}>
          <Icon icon={CheckCircle2Icon} size={12} />
          {t('aiProviderSettings.sharedOAuth.connected')}
        </Flexbox>
      </Tag>
    );
  },
);

SharedOAuthBadge.displayName = 'AdminSharedOAuthBadge';

export default SharedOAuthBadge;
