'use client';

import { Flexbox, Icon } from '@lobehub/ui';
import { Alert, Tag, Typography } from 'antd';
import { CheckCircle2, XCircle } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { CapabilityResult } from './types';
import { isCapabilityVersionTooLow } from './utils';

interface CapabilityStatusProps {
  capabilityResult: CapabilityResult | undefined;
  checkingCapability: boolean;
  deviceId: string | undefined;
  platformName: string;
}

const CapabilityStatus = memo<CapabilityStatusProps>(
  ({ capabilityResult, checkingCapability, deviceId, platformName }) => {
    const { t } = useTranslation('chat');

    if (!deviceId) return null;
    if (checkingCapability)
      return <Tag style={{ marginInlineEnd: 0 }}>{t('platformAgent.create.checking')}</Tag>;
    if (!capabilityResult) return null;
    if (capabilityResult.available) {
      return (
        <Flexbox horizontal align="flex-start" gap={4} style={{ flexWrap: 'wrap' }}>
          <Icon
            color="var(--ant-color-success)"
            icon={CheckCircle2}
            size={14}
            style={{ marginTop: 2, flexShrink: 0 }}
          />
          <Tag
            color="success"
            style={{ marginInlineEnd: 0, whiteSpace: 'normal', wordBreak: 'break-word' }}
          >
            {capabilityResult.version ?? t('platformAgent.create.available')}
          </Tag>
        </Flexbox>
      );
    }

    if (isCapabilityVersionTooLow(capabilityResult)) {
      return (
        <Alert
          showIcon
          message={t('platformAgent.create.versionTooLow')}
          type="warning"
          description={
            <Flexbox gap={4}>
              <span>{t('platformAgent.create.versionTooLowHint')}</span>
              <Typography.Text code copyable>
                {t('platformAgent.create.upgradeCmd')}
              </Typography.Text>
            </Flexbox>
          }
        />
      );
    }

    return (
      <Flexbox horizontal align="center" gap={4}>
        <Icon color="var(--ant-color-error)" icon={XCircle} size={14} />
        <Tag color="error" style={{ marginInlineEnd: 0 }}>
          {capabilityResult.reason ??
            t('platformAgent.create.notInstalled', { name: platformName })}
        </Tag>
      </Flexbox>
    );
  },
);

CapabilityStatus.displayName = 'CapabilityStatus';

export default CapabilityStatus;
