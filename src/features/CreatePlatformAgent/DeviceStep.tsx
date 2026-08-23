'use client';

import type { DeviceListItem } from '@lobechat/types';
import { Button, Flexbox, Icon } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { Alert, Tag, Typography } from 'antd';
import { BotIcon, Download, RefreshCw } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import CapabilityStatus from './CapabilityStatus';
import { styles } from './style';
import type { CapabilityResult } from './types';
import { selectSelectableDevices } from './utils';

interface DeviceStepProps {
  capabilityResult: CapabilityResult | undefined;
  checkingCapability: boolean;
  deviceId: string | undefined;
  devices: DeviceListItem[] | undefined;
  isRefreshing: boolean;
  onDeviceChange: (deviceId: string) => void;
  onRefresh: () => void;
  platformName: string;
  restrictToWorkspaceDevices: boolean;
}

const DeviceStep = memo<DeviceStepProps>(
  ({
    capabilityResult,
    checkingCapability,
    deviceId,
    devices,
    isRefreshing,
    onDeviceChange,
    onRefresh,
    platformName,
    restrictToWorkspaceDevices,
  }) => {
    const { t } = useTranslation('chat');

    const onlineDevices = selectSelectableDevices(devices, restrictToWorkspaceDevices);

    const refreshButton = (
      <Button
        icon={<Icon icon={RefreshCw} size={13} />}
        loading={isRefreshing}
        size="small"
        type="text"
        onClick={onRefresh}
      >
        {t('platformAgent.create.refresh')}
      </Button>
    );

    if (!isRefreshing && onlineDevices.length === 0) {
      return (
        <Flexbox gap={12}>
          <Alert
            showIcon
            message={t('platformAgent.create.noDevices')}
            type="info"
            description={
              <Flexbox gap={12}>
                <Flexbox gap={6}>
                  <span>{t('platformAgent.create.noDevicesDesktopHint')}</span>
                  <a href="https://lobehub.com/downloads" rel="noreferrer" target="_blank">
                    <Button icon={<Icon icon={Download} size={13} />} size="small" type="primary">
                      {t('platformAgent.create.downloadDesktop')}
                    </Button>
                  </a>
                </Flexbox>
                <Flexbox gap={4}>
                  <span>{t('platformAgent.create.noDevicesCliHint')}</span>
                  <Typography.Text code copyable>
                    {t('platformAgent.create.noDevicesCmd')}
                  </Typography.Text>
                </Flexbox>
              </Flexbox>
            }
          />
          {refreshButton}
        </Flexbox>
      );
    }

    return (
      <Flexbox gap={12}>
        <Flexbox horizontal align="center" gap={8}>
          <Select
            loading={isRefreshing}
            placeholder={t('platformAgent.create.selectDevice')}
            style={{ flex: 1 }}
            value={deviceId}
            options={onlineDevices.map((d) => ({
              label: (
                <div className={styles.deviceItem}>
                  <Icon icon={BotIcon} size={14} />
                  <span>{d.hostname}</span>
                  <Tag color="success" style={{ marginInlineEnd: 0 }}>
                    {t('platformAgent.device.online')}
                  </Tag>
                </div>
              ),
              value: d.deviceId,
            }))}
            onChange={onDeviceChange}
          />
          {refreshButton}
        </Flexbox>
        <CapabilityStatus
          capabilityResult={capabilityResult}
          checkingCapability={checkingCapability}
          deviceId={deviceId}
          platformName={platformName}
        />
      </Flexbox>
    );
  },
);

DeviceStep.displayName = 'DeviceStep';

export default DeviceStep;
