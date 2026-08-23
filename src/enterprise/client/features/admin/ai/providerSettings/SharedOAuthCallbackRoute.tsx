'use client';

import { Flexbox, Icon, Text } from '@lobehub/ui';
import { Button, TextArea } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { ExternalLinkIcon } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { SharedOAuthPasteError } from './useAdminSharedOAuthFlow';

const styles = createStaticStyles(({ css, cssVar }) => ({
  error: css`
    font-size: 12px;
    color: ${cssVar.colorError};
  `,
  label: css`
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  meta: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  uri: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
    overflow-wrap: anywhere;
  `,
}));

interface SharedOAuthCallbackRouteProps {
  authorizeUri: string;
  error?: SharedOAuthPasteError;
  errorId: string;
  fieldId: string;
  onCancel: () => void;
  onOpenAuthorizePage: () => void;
  onRegenerate: () => void;
  onSubmit: (callbackUrl: string) => void;
  submitting?: boolean;
}

/**
 * The primary route of the paste flow: send the operator to the provider's authorization
 * page, then take the callback URL they come back with. A fragment, so it keeps sharing the
 * form's own column gap rather than nesting a second one.
 */
const SharedOAuthCallbackRoute = memo<SharedOAuthCallbackRouteProps>(
  ({
    authorizeUri,
    error,
    errorId,
    fieldId,
    onCancel,
    onOpenAuthorizePage,
    onRegenerate,
    onSubmit,
    submitting,
  }) => {
    const { t } = useTranslation('admin');
    const [callbackUrl, setCallbackUrl] = useState('');

    const handleSubmit = useCallback(() => {
      const value = callbackUrl.trim();
      if (!value) return;
      onSubmit(value);
    }, [callbackUrl, onSubmit]);

    return (
      <>
        <Text className={styles.meta}>{t('aiProviderSettings.sharedOAuth.paste.instruction')}</Text>
        <Flexbox horizontal align={'center'} gap={8}>
          <Button
            icon={<Icon icon={ExternalLinkIcon} />}
            type={'primary'}
            onClick={onOpenAuthorizePage}
          >
            {t('aiProviderSettings.sharedOAuth.paste.openAuthorizePage')}
          </Button>
          <Button onClick={onRegenerate}>
            {t('aiProviderSettings.sharedOAuth.paste.regenerate')}
          </Button>
          <Button onClick={onCancel}>{t('aiProviderSettings.sharedOAuth.cancel')}</Button>
        </Flexbox>
        <Text className={styles.uri}>{authorizeUri}</Text>

        <label className={styles.label} htmlFor={fieldId}>
          {t('aiProviderSettings.sharedOAuth.paste.callbackLabel')}
        </label>
        <TextArea
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          autoCapitalize={'none'}
          // A live authorization code: never autofilled, never corrected, and never handed
          // to a spellchecker that may ship it off-device.
          autoComplete={'off'}
          autoCorrect={'off'}
          autoSize={{ maxRows: 4, minRows: 2 }}
          id={fieldId}
          placeholder={t('aiProviderSettings.sharedOAuth.paste.callbackPlaceholder')}
          spellCheck={false}
          value={callbackUrl}
          onChange={(e) => setCallbackUrl(e.target.value)}
        />
        {error && (
          <Text className={styles.error} id={errorId} role={'alert'}>
            {t(`aiProviderSettings.sharedOAuth.paste.errors.${error}` as any)}
          </Text>
        )}
        <Flexbox horizontal>
          <Button
            disabled={!callbackUrl.trim()}
            loading={submitting}
            type={'primary'}
            onClick={handleSubmit}
          >
            {t('aiProviderSettings.sharedOAuth.paste.submit')}
          </Button>
        </Flexbox>
      </>
    );
  },
);

SharedOAuthCallbackRoute.displayName = 'AdminSharedOAuthCallbackRoute';

export default SharedOAuthCallbackRoute;
