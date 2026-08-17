'use client';

import { Alert, Empty, Skeleton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Drawer } from 'antd';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminNetworkProxyService } from '@/enterprise/client/services/adminNetworkProxy';

import { useNetworkProxyEngineLogs } from '../hooks';
import { networkProxyStyles as styles } from '../styles';

export interface EngineLogsDrawerProps {
  onClose: () => void;
  open: boolean;
  service?: AdminNetworkProxyService;
}

/**
 * Last 200 engine log lines from the instance that answers this request (design §6.1).
 * Lines are redacted server-side; the drawer states which instance they came from so nobody
 * reads a quiet log on instance A as proof that instance B is healthy.
 */
const EngineLogsDrawer = memo<EngineLogsDrawerProps>(({ onClose, open, service }) => {
  const { t } = useTranslation('admin');
  const { data, error, isLoading, mutate } = useNetworkProxyEngineLogs(open, service);

  return (
    <Drawer
      destroyOnClose
      open={open}
      title={t('networkProxy.engine.logs.title')}
      width={720}
      extra={
        <Button size="small" onClick={() => void mutate()}>
          {t('networkProxy.actions.refresh')}
        </Button>
      }
      onClose={onClose}
    >
      {isLoading && !data ? <Skeleton.Block height={240} width="100%" /> : null}

      {error && !data ? (
        <Alert
          showIcon
          description={t('networkProxy.engine.logs.loadFailedDesc')}
          message={t('networkProxy.engine.logs.loadFailed')}
          type="error"
          action={
            <Button size="small" onClick={() => void mutate()}>
              {t('networkProxy.actions.retry')}
            </Button>
          }
        />
      ) : null}

      {data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Text className={styles.tableCaption}>
            {t('networkProxy.engine.logs.fromInstance', { instance: data.instanceId })}
          </Text>
          {data.lines.length === 0 ? (
            <Empty description={t('networkProxy.engine.logs.empty')} />
          ) : (
            <div className={styles.logPanel}>
              {data.lines.map((line, index) => (
                <div className={styles.logLine} key={`${index}-${line.slice(0, 24)}`}>
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </Drawer>
  );
});

EngineLogsDrawer.displayName = 'NetworkProxyEngineLogsDrawer';

export default EngineLogsDrawer;
