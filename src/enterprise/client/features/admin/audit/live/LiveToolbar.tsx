'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AuditUserSearchSelect from '../shared/AuditUserSearchSelect';
import { formatAdminDateTime } from '../shared/format';
import { styles } from './liveStyles';

export interface LiveToolbarProps {
  canAuditRead: boolean;
  lastRefreshedAt: Date | null;
  live: boolean;
  onRefreshNow: () => void;
  onUserChange: (id: string | undefined) => void;
  pageVisible: boolean;
  setLive: (live: boolean) => void;
  userId: string | undefined;
}

/** Subject picker + live switch + manual refresh for the audit live page. */
const LiveToolbar = memo<LiveToolbarProps>(
  ({
    canAuditRead,
    lastRefreshedAt,
    live,
    onRefreshNow,
    onUserChange,
    pageVisible,
    setLive,
    userId,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.toolbar}>
        <div style={{ minWidth: 240, flex: '1 1 240px', maxWidth: 360 }}>
          <AuditUserSearchSelect
            enabled={canAuditRead}
            placeholder={t('audit.live.filters.user')}
            style={{ width: '100%' }}
            value={userId}
            onChange={onUserChange}
          />
        </div>
        <Flexbox horizontal align="center" gap={8}>
          <span className={styles.liveDot} data-on={live && pageVisible} />
          <Text type="secondary">{t('audit.live.filters.live')}</Text>
          <Switch checked={live} onChange={(v) => setLive(Boolean(v))} />
          {lastRefreshedAt ? (
            <Text style={{ fontSize: 12 }} type="secondary">
              {t('audit.live.filters.refreshed', {
                time: formatAdminDateTime(lastRefreshedAt),
              })}
            </Text>
          ) : null}
        </Flexbox>
        {live ? null : (
          <Button size="small" type="default" onClick={onRefreshNow}>
            {t('audit.live.filters.refreshNow')}
          </Button>
        )}
      </div>
    );
  },
);

LiveToolbar.displayName = 'AuditLiveToolbar';

export default LiveToolbar;
