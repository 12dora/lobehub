'use client';

import { parseChatGPTWebPaste } from '@lobechat/utils/chatgptWebPaste';
import { Flexbox, Icon, Text } from '@lobehub/ui';
import { Button, TextArea } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { ExternalLinkIcon } from 'lucide-react';
import { memo, useCallback, useId, useMemo, useState } from 'react';
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
  /** Provider offers the "paste a credential instead" route (web session or access token). */
  allowAccessTokenPaste?: boolean;
  /** Authorization page the user has to open and sign in on. */
  authorizeUri: string;
  /**
   * Open the pasted-credential section immediately — set when the user arrived from the
   * "this connection cannot renew itself" warning, whose fix IS that section.
   */
  defaultSessionOpen?: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onOpenAuthorizePage: () => void;
  /** Start a fresh authorization link (the previous one is single-use). */
  onRegenerate: () => void;
  onSubmitAccessToken: (accessToken: string) => void;
  onSubmitCallback: (callbackUrl: string) => void;
  onSubmitSessionToken: (sessionToken: string) => void;
  submitError?: PasteSubmitError;
  /** Which input the failed submit came from; decides where the error is shown. */
  submitErrorSource?: PasteSubmitSource;
  submitting?: boolean;
}

/** Submit errors that belong to the pasted-credential box rather than the callback box. */
const TOKEN_SOURCE_ERRORS = new Set<PasteSubmitError>([
  'accessTokenInvalid',
  'sessionInvalid',
  'tokenNotWeb',
]);

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
    defaultSessionOpen,
    disabled,
    onCancel,
    onOpenAuthorizePage,
    onRegenerate,
    onSubmitAccessToken,
    onSubmitCallback,
    onSubmitSessionToken,
    submitError,
    submitErrorSource,
    submitting,
  }) => {
    const { t } = useTranslation('modelProvider');
    const [callbackUrl, setCallbackUrl] = useState('');
    const [pasted, setPasted] = useState('');
    const [showTokenSection, setShowTokenSection] = useState(Boolean(defaultSessionOpen));
    const fieldGroupId = useId();
    const callbackFieldId = `${fieldGroupId}-callback`;
    const callbackErrorId = `${fieldGroupId}-callback-error`;
    const tokenFieldId = `${fieldGroupId}-token`;
    const tokenErrorId = `${fieldGroupId}-token-error`;
    const tokenSectionId = `${fieldGroupId}-token-section`;
    const detectionId = `${fieldGroupId}-detection`;

    /**
     * One error at a time, attached to the field that produced it: a rejected session must
     * not paint the callback box red, or the user fixes the wrong thing.
     *
     * The SOURCE decides, not the literal: a network failure or an unmapped code becomes the
     * generic `authError`, which belongs to whichever input was submitted. Reading the
     * literal alone put every such failure on the callback box.
     */
    const errorSource =
      submitErrorSource ??
      (submitError && TOKEN_SOURCE_ERRORS.has(submitError) ? 'token' : 'callback');
    const tokenError = submitError && errorSource === 'token' ? submitError : undefined;
    const callbackError = submitError && !tokenError ? submitError : undefined;

    /**
     * What was pasted, resolved live: a session cookie, a whole "Copy as cURL" command, the
     * JSON body of `/api/auth/session`, or a bare access token. The difference that matters
     * — a web session renews itself, an access token does not — is invisible in the raw
     * text, so it is stated before anything is submitted.
     */
    const parsed = useMemo(() => parseChatGPTWebPaste(pasted), [pasted]);
    const detection =
      pasted.trim().length === 0
        ? undefined
        : parsed.kind === 'web_session'
          ? 'session'
          : parsed.kind === 'access_token'
            ? 'accessToken'
            : 'unknown';

    const handleSubmitCallback = useCallback(() => {
      const value = callbackUrl.trim();
      if (!value) return;
      onSubmitCallback(value);
    }, [callbackUrl, onSubmitCallback]);

    /** Always submit the renewable half when the paste carried both. */
    const handleSubmitPasted = useCallback(() => {
      if (parsed.sessionToken) onSubmitSessionToken(parsed.sessionToken);
      else if (parsed.accessToken) onSubmitAccessToken(parsed.accessToken);
    }, [onSubmitAccessToken, onSubmitSessionToken, parsed.accessToken, parsed.sessionToken]);

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
            autoCapitalize="none"
            // A live authorization code: never autofilled, never corrected, and never handed
            // to a spellchecker that may ship it off-device.
            autoComplete="off"
            autoCorrect="off"
            autoSize={{ maxRows: 4, minRows: 2 }}
            disabled={disabled}
            id={callbackFieldId}
            placeholder={t('providerModels.config.oauth.paste.callbackPlaceholder')}
            spellCheck={false}
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
                {t('providerModels.config.oauth.paste.sessionToggle')}
              </Button>
            </Flexbox>
            {showTokenSection && (
              <Flexbox gap={8} id={tokenSectionId}>
                <label className={styles.label} htmlFor={tokenFieldId}>
                  {t('providerModels.config.oauth.paste.sessionLabel')}
                </label>
                <TextArea
                  aria-invalid={tokenError ? true : undefined}
                  autoCapitalize="none"
                  // A raw session cookie: no autofill, no autocorrect mangling it, and no
                  // spellchecker — which on several platforms means uploading it.
                  autoComplete="off"
                  autoCorrect="off"
                  autoSize={{ maxRows: 6, minRows: 3 }}
                  disabled={disabled}
                  id={tokenFieldId}
                  placeholder={t('providerModels.config.oauth.paste.sessionPlaceholder')}
                  spellCheck={false}
                  value={pasted}
                  aria-describedby={
                    [tokenError ? tokenErrorId : undefined, detection ? detectionId : undefined]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  onChange={(e) => setPasted(e.target.value)}
                />
                {detection && (
                  <Text
                    className={styles.hint}
                    id={detectionId}
                    // Live, because it changes while the user types into the box above.
                    role="status"
                    type={detection === 'session' ? 'secondary' : 'warning'}
                  >
                    {t(`providerModels.config.oauth.paste.detected.${detection}` as any)}
                  </Text>
                )}
                {tokenError && (
                  <Text className={styles.errorText} id={tokenErrorId} role="alert">
                    {t(`providerModels.config.oauth.paste.errors.${tokenError}` as any)}
                  </Text>
                )}
                <Text className={styles.hint}>
                  {t('providerModels.config.oauth.paste.sessionHint')}
                </Text>
                <Button
                  block
                  disabled={disabled || parsed.kind === 'unknown'}
                  loading={submitting}
                  onClick={handleSubmitPasted}
                >
                  {t('providerModels.config.oauth.paste.sessionSubmit')}
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
