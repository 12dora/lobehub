'use client';

import { Flexbox, Icon, Text } from '@lobehub/ui';
import { Button, InputPassword, TextArea } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { ExternalLinkIcon } from 'lucide-react';
import { memo, useCallback, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PasteSubmitError, PasteSubmitSource } from './useOAuthDeviceFlow';

const styles = createStaticStyles(({ css, cssVar }) => ({
  errorText: css`
    font-size: 13px;
    color: ${cssVar.colorError};
  `,
  hint: css`
    font-size: 13px;
    color: ${cssVar.colorTextDescription};
  `,
  instruction: css`
    font-size: 13px;
    line-height: 1.6;
    color: ${cssVar.colorTextSecondary};
  `,
  label: css`
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  panel: css`
    width: 100%;
  `,
  secondarySection: css`
    width: 100%;
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  uri: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    overflow-wrap: anywhere;
  `,
}));

export interface PasteFlowPanelProps {
  /** Provider offers the "paste an access token instead" fallback. */
  allowAccessTokenPaste?: boolean;
  /** Authorization page the user has to open and sign in on. */
  authorizeUri: string;
  disabled?: boolean;
  onCancel: () => void;
  onOpenAuthorizePage: () => void;
  /** Start a fresh authorization link (the previous one is single-use). */
  onRegenerate: () => void;
  onSubmitAccessToken: (accessToken: string) => void;
  onSubmitCallback: (callbackUrl: string) => void;
  submitError?: PasteSubmitError;
  /** Which input the failed submit came from; decides where the error is shown. */
  submitErrorSource?: PasteSubmitSource;
  submitting?: boolean;
}

/**
 * Connect UI for the authorization-code paste flow: the provider's redirect URI points at
 * its own site, so the user carries the result back by hand. Nothing is polled — the three
 * steps (open, sign in, paste) are laid out in the order they happen so the user always
 * knows what the app is waiting for.
 */
const PasteFlowPanel = memo<PasteFlowPanelProps>(
  ({
    allowAccessTokenPaste,
    authorizeUri,
    disabled,
    onCancel,
    onOpenAuthorizePage,
    onRegenerate,
    onSubmitAccessToken,
    onSubmitCallback,
    submitError,
    submitErrorSource,
    submitting,
  }) => {
    const { t } = useTranslation('modelProvider');
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
     * must not paint the callback box red, or the user fixes the wrong thing.
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
      <Flexbox className={styles.panel} gap={16}>
        <Flexbox gap={12}>
          <Button
            block
            disabled={disabled}
            icon={<Icon icon={ExternalLinkIcon} />}
            size="large"
            type="primary"
            onClick={onOpenAuthorizePage}
          >
            {t('providerModels.config.oauth.paste.openAuthorizePage')}
          </Button>
          <a className={styles.uri} href={authorizeUri} rel="noopener noreferrer" target="_blank">
            {authorizeUri}
          </a>
        </Flexbox>

        <Text className={styles.instruction}>
          {t('providerModels.config.oauth.paste.instruction')}
        </Text>

        <Flexbox gap={8}>
          <label className={styles.label} htmlFor={callbackFieldId}>
            {t('providerModels.config.oauth.paste.callbackLabel')}
          </label>
          <TextArea
            aria-describedby={callbackError ? callbackErrorId : undefined}
            aria-invalid={callbackError ? true : undefined}
            autoSize={{ maxRows: 4, minRows: 2 }}
            disabled={disabled}
            id={callbackFieldId}
            placeholder={t('providerModels.config.oauth.paste.callbackPlaceholder')}
            value={callbackUrl}
            onChange={(e) => setCallbackUrl(e.target.value)}
          />
          {callbackError && (
            <Text className={styles.errorText} id={callbackErrorId} role="alert">
              {t(`providerModels.config.oauth.paste.errors.${callbackError}` as any)}
            </Text>
          )}
          <Button
            block
            disabled={disabled || !callbackUrl.trim()}
            loading={submitting}
            type="primary"
            onClick={handleSubmitCallback}
          >
            {t('providerModels.config.oauth.paste.submit')}
          </Button>
        </Flexbox>

        <Flexbox horizontal align="center" gap={8} justify="center">
          <Button size="small" type="text" onClick={onRegenerate}>
            {t('providerModels.config.oauth.paste.regenerate')}
          </Button>
          <Button size="small" type="text" onClick={onCancel}>
            {t('providerModels.config.oauth.cancel')}
          </Button>
        </Flexbox>

        {allowAccessTokenPaste && (
          <Flexbox className={styles.secondarySection} gap={8}>
            <Flexbox horizontal>
              <Button
                aria-controls={tokenSectionId}
                aria-expanded={showTokenSection}
                size="small"
                type="text"
                onClick={() => setShowTokenSection((open) => !open)}
              >
                {t('providerModels.config.oauth.paste.accessTokenToggle')}
              </Button>
            </Flexbox>
            {showTokenSection && (
              <Flexbox gap={8} id={tokenSectionId}>
                <label className={styles.label} htmlFor={tokenFieldId}>
                  {t('providerModels.config.oauth.paste.accessTokenLabel')}
                </label>
                <InputPassword
                  aria-describedby={tokenError ? tokenErrorId : undefined}
                  aria-invalid={tokenError ? true : undefined}
                  disabled={disabled}
                  id={tokenFieldId}
                  placeholder={t('providerModels.config.oauth.paste.accessTokenPlaceholder')}
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                />
                {tokenError && (
                  <Text className={styles.errorText} id={tokenErrorId} role="alert">
                    {t(`providerModels.config.oauth.paste.errors.${tokenError}` as any)}
                  </Text>
                )}
                <Text className={styles.hint}>
                  {t('providerModels.config.oauth.paste.accessTokenNoRenewHint')}
                </Text>
                <Button
                  block
                  disabled={disabled || !accessToken.trim()}
                  loading={submitting}
                  onClick={handleSubmitAccessToken}
                >
                  {t('providerModels.config.oauth.paste.accessTokenSubmit')}
                </Button>
              </Flexbox>
            )}
          </Flexbox>
        )}
      </Flexbox>
    );
  },
);

PasteFlowPanel.displayName = 'OAuthPasteFlowPanel';

export default PasteFlowPanel;
