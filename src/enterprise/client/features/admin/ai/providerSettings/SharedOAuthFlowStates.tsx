'use client';

import { CopyButton, Flexbox, Icon, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ExternalLinkIcon, Loader2Icon, UnplugIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  SharedOAuthDeviceCode,
  SharedOAuthFlowError,
  SharedOAuthFlowState,
} from './useAdminSharedOAuthFlow';

const styles = createStaticStyles(({ css, cssVar }) => ({
  code: css`
    padding-block: 12px;
    padding-inline: 20px;
    border-radius: 8px;

    font-family: ${cssVar.fontFamilyCode};
    font-size: 24px;
    font-weight: 600;
    letter-spacing: 4px;

    background: ${cssVar.colorFillTertiary};
  `,
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  meta: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

interface SharedOAuthFlowStatesProps {
  deviceCode?: SharedOAuthDeviceCode;
  error?: SharedOAuthFlowError;
  name: string;
  onConnect: () => void;
  onOpenVerification: () => void;
  onReset: () => void;
  state: SharedOAuthFlowState;
}

const SharedOAuthFlowStates = memo<SharedOAuthFlowStatesProps>(
  ({ deviceCode, error, name, onConnect, onOpenVerification, onReset, state }) => {
    const { t } = useTranslation('admin');

    if (state === 'requesting') {
      // Always offer a way out: the provider can stall for minutes on this call, and the
      // flow's staleness guards make a cancelled request safe to discard when it lands.
      return (
        <Flexbox gap={12}>
          <Flexbox horizontal align={'center'} gap={8}>
            <Icon spin icon={Loader2Icon} />
            <Text type={'secondary'}>{t('aiProviderSettings.sharedOAuth.requesting')}</Text>
          </Flexbox>
          <Flexbox horizontal>
            <Button onClick={onReset}>{t('aiProviderSettings.sharedOAuth.cancel')}</Button>
          </Flexbox>
        </Flexbox>
      );
    }

    if (state === 'error') {
      return (
        <Flexbox gap={12}>
          <Flexbox horizontal align={'center'} gap={8}>
            <Icon color={cssVar.colorError} icon={UnplugIcon} />
            <Text type={'danger'}>
              {t(`aiProviderSettings.sharedOAuth.error.${error ?? 'authError'}` as any)}
            </Text>
          </Flexbox>
          <Flexbox horizontal gap={8}>
            <Button type={'primary'} onClick={onConnect}>
              {t('aiProviderSettings.sharedOAuth.retry')}
            </Button>
            <Button onClick={onReset}>{t('aiProviderSettings.sharedOAuth.cancel')}</Button>
          </Flexbox>
        </Flexbox>
      );
    }

    if (state === 'awaiting' && deviceCode) {
      return (
        <Flexbox gap={12}>
          <Text className={styles.meta}>
            {t('aiProviderSettings.sharedOAuth.enterCode', { name })}
          </Text>
          <Flexbox horizontal align={'center'} gap={12}>
            <div className={styles.code}>{deviceCode.userCode}</div>
            <CopyButton content={deviceCode.userCode} />
          </Flexbox>
          <Flexbox horizontal align={'center'} gap={8}>
            <Button
              icon={<Icon icon={ExternalLinkIcon} />}
              type={'primary'}
              onClick={onOpenVerification}
            >
              {t('aiProviderSettings.sharedOAuth.openPage')}
            </Button>
            <Button onClick={onReset}>{t('aiProviderSettings.sharedOAuth.cancel')}</Button>
          </Flexbox>
          <Flexbox horizontal align={'center'} gap={8}>
            <Icon spin icon={Loader2Icon} />
            <Text className={styles.hint}>{t('aiProviderSettings.sharedOAuth.polling')}</Text>
          </Flexbox>
          <Text className={styles.hint}>{deviceCode.verificationUri}</Text>
        </Flexbox>
      );
    }

    return null;
  },
);

SharedOAuthFlowStates.displayName = 'AdminSharedOAuthFlowStates';

export default SharedOAuthFlowStates;
