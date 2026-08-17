'use client';

import { CopyButton, Flexbox, Icon, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ExternalLinkIcon, Loader2Icon, UnplugIcon } from 'lucide-react';
import type { ReactNode } from 'react';
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
  url: css`
    min-width: 0;
    font-size: 12px;
    overflow-wrap: anywhere;
  `,
}));

interface SharedOAuthFlowStatesProps {
  /**
   * The provider's OTHER connect route, rendered between the polling hint and the copyable
   * fallback URL. It is a real alternative, so it must not sit UNDER what reads as debug
   * output — and the URL is the last-resort remedy, so it belongs last.
   */
  alternativeRoute?: ReactNode;
  deviceCode?: SharedOAuthDeviceCode;
  error?: SharedOAuthFlowError;
  name: string;
  onConnect: () => void;
  onOpenVerification: () => void;
  onReset: () => void;
  state: SharedOAuthFlowState;
}

const SharedOAuthFlowStates = memo<SharedOAuthFlowStatesProps>(
  ({
    alternativeRoute,
    deviceCode,
    error,
    name,
    onConnect,
    onOpenVerification,
    onReset,
    state,
  }) => {
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
      /**
       * Not every device-flow provider hands out a code. Cursor's browser login is approved
       * on the page itself (the server returns an empty `userCode`), so a code box and
       * "enter this code" instructions would send the operator looking for something that
       * does not exist. Read off the server's own answer, never off the provider id.
       */
      const hasUserCode = Boolean(deviceCode.userCode);
      const fallbackUri = hasUserCode
        ? deviceCode.verificationUri
        : deviceCode.verificationUriComplete || deviceCode.verificationUri;

      return (
        <Flexbox gap={12}>
          <Text className={styles.meta}>
            {hasUserCode
              ? t('aiProviderSettings.sharedOAuth.enterCode', { name })
              : t('aiProviderSettings.sharedOAuth.openLinkToAuthorize', { name })}
          </Text>
          {hasUserCode && (
            <Flexbox horizontal align={'center'} gap={12}>
              <div className={styles.code}>{deviceCode.userCode}</div>
              <CopyButton content={deviceCode.userCode} />
            </Flexbox>
          )}
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
          {alternativeRoute}
          {/*
            The copy/paste fallback for a blocked popup, so it has to be the URL that actually
            authorizes: without a user code the bare verification page carries no challenge
            and approves nothing, so the prefilled URI is the only usable one.

            Labelled, linked and copyable — as a bare grey paragraph a 190-char deep-link read
            as a stack trace, and it is the whole remedy when the popup was blocked.
          */}
          <Flexbox gap={4}>
            <Text className={styles.hint}>
              {t('aiProviderSettings.sharedOAuth.verificationUrlLabel')}
            </Text>
            <Flexbox horizontal align={'center'} gap={8}>
              <a className={styles.url} href={fallbackUri} rel={'noreferrer'} target={'_blank'}>
                {fallbackUri}
              </a>
              <CopyButton content={fallbackUri} size={'small'} />
            </Flexbox>
          </Flexbox>
        </Flexbox>
      );
    }

    return null;
  },
);

SharedOAuthFlowStates.displayName = 'AdminSharedOAuthFlowStates';

export default SharedOAuthFlowStates;
