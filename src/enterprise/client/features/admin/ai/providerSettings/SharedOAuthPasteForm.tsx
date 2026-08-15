'use client';

import { Flexbox, Icon, Text } from '@lobehub/ui';
import { Button, InputPassword, TextArea } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { ExternalLinkIcon } from 'lucide-react';
import { memo, useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { SharedOAuthPasteError, SharedOAuthPasteSource } from './useAdminSharedOAuthFlow';

const styles = createStaticStyles(({ css, cssVar }) => ({
  error: css`
    font-size: 12px;
    color: ${cssVar.colorError};
  `,
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
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

interface SharedOAuthPasteFormProps {
  allowAccessTokenPaste?: boolean;
  authorizeUri: string;
  onCancel: () => void;
  onOpenAuthorizePage: () => void;
  onRegenerate: () => void;
  onSubmitAccessToken: (accessToken: string) => void;
  onSubmitCallback: (callbackUrl: string) => void;
  submitError?: SharedOAuthPasteError;
  /** Which input the failed submit came from; decides where the error is shown. */
  submitErrorSource?: SharedOAuthPasteSource;
  submitting?: boolean;
}

/**
 * Shared-account variant of the authorization-code paste flow: the operator signs in as the
 * ONE platform account in a browser, then brings the callback URL back here. No polling —
 * the provider's redirect URI never reaches this deployment.
 */
const SharedOAuthPasteForm = memo<SharedOAuthPasteFormProps>(
  ({
    allowAccessTokenPaste,
    authorizeUri,
    onCancel,
    onOpenAuthorizePage,
    onRegenerate,
    onSubmitAccessToken,
    onSubmitCallback,
    submitError,
    submitErrorSource,
    submitting,
  }) => {
    const { t } = useTranslation('admin');
    const [callbackUrl, setCallbackUrl] = useState('');
    const [accessToken, setAccessToken] = useState('');
    const [showTokenSection, setShowTokenSection] = useState(false);
    const fieldGroupId = useId();
    const callbackFieldId = `${fieldGroupId}-callback`;
    const callbackErrorId = `${fieldGroupId}-callback-error`;
    const tokenFieldId = `${fieldGroupId}-token`;
    const tokenErrorId = `${fieldGroupId}-token-error`;
    const tokenSectionId = `${fieldGroupId}-token-section`;

    /**
     * One error at a time, attached to the field that produced it: a rejected access token
     * must not paint the callback box red, or the operator fixes the wrong thing.
     *
     * The SOURCE decides, not the literal: a network failure or an unmapped code becomes the
     * generic `authError`, which belongs to whichever input was submitted. Reading the
     * literal alone put every such failure on the callback box. `accessTokenInvalid` is the
     * fallback for a source-less error, since only the token path can produce it.
     */
    const errorSource =
      submitErrorSource ?? (submitError === 'accessTokenInvalid' ? 'token' : 'callback');
    const tokenError = submitError && errorSource === 'token' ? submitError : undefined;
    const callbackError = submitError && !tokenError ? submitError : undefined;

    const handleSubmitCallback = useCallback(() => {
      const value = callbackUrl.trim();
      if (!value) return;
      onSubmitCallback(value);
    }, [callbackUrl, onSubmitCallback]);

    const handleSubmitAccessToken = useCallback(() => {
      const value = accessToken.trim();
      if (!value) return;
      onSubmitAccessToken(value);
    }, [accessToken, onSubmitAccessToken]);

    return (
      <Flexbox gap={12}>
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

        <label className={styles.label} htmlFor={callbackFieldId}>
          {t('aiProviderSettings.sharedOAuth.paste.callbackLabel')}
        </label>
        <TextArea
          aria-describedby={callbackError ? callbackErrorId : undefined}
          aria-invalid={callbackError ? true : undefined}
          autoSize={{ maxRows: 4, minRows: 2 }}
          id={callbackFieldId}
          placeholder={t('aiProviderSettings.sharedOAuth.paste.callbackPlaceholder')}
          value={callbackUrl}
          onChange={(e) => setCallbackUrl(e.target.value)}
        />
        {callbackError && (
          <Text className={styles.error} id={callbackErrorId} role={'alert'}>
            {t(`aiProviderSettings.sharedOAuth.paste.errors.${callbackError}` as any)}
          </Text>
        )}
        <Flexbox horizontal>
          <Button
            disabled={!callbackUrl.trim()}
            loading={submitting}
            type={'primary'}
            onClick={handleSubmitCallback}
          >
            {t('aiProviderSettings.sharedOAuth.paste.submit')}
          </Button>
        </Flexbox>

        {allowAccessTokenPaste && (
          <Flexbox gap={8}>
            <Flexbox horizontal>
              <Button
                aria-controls={tokenSectionId}
                aria-expanded={showTokenSection}
                size={'small'}
                type={'text'}
                onClick={() => setShowTokenSection((open) => !open)}
              >
                {t('aiProviderSettings.sharedOAuth.paste.accessTokenToggle')}
              </Button>
            </Flexbox>
            {showTokenSection && (
              <Flexbox gap={8} id={tokenSectionId}>
                <label className={styles.label} htmlFor={tokenFieldId}>
                  {t('aiProviderSettings.sharedOAuth.paste.accessTokenLabel')}
                </label>
                <InputPassword
                  aria-describedby={tokenError ? tokenErrorId : undefined}
                  aria-invalid={tokenError ? true : undefined}
                  id={tokenFieldId}
                  placeholder={t('aiProviderSettings.sharedOAuth.paste.accessTokenPlaceholder')}
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                />
                {tokenError && (
                  <Text className={styles.error} id={tokenErrorId} role={'alert'}>
                    {t(`aiProviderSettings.sharedOAuth.paste.errors.${tokenError}` as any)}
                  </Text>
                )}
                <Text className={styles.hint}>
                  {t('aiProviderSettings.sharedOAuth.paste.accessTokenNoRenewHint')}
                </Text>
                <Flexbox horizontal>
                  <Button
                    disabled={!accessToken.trim()}
                    loading={submitting}
                    onClick={handleSubmitAccessToken}
                  >
                    {t('aiProviderSettings.sharedOAuth.paste.accessTokenSubmit')}
                  </Button>
                </Flexbox>
              </Flexbox>
            )}
          </Flexbox>
        )}
      </Flexbox>
    );
  },
);

SharedOAuthPasteForm.displayName = 'AdminSharedOAuthPasteForm';

export default SharedOAuthPasteForm;
