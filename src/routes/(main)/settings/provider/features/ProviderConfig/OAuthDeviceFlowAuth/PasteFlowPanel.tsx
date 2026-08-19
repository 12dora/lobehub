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
  /** Inline external link: the connect steps used to name pages with nothing to click. */
  link: css`
    display: inline-flex;
    gap: 4px;
    align-items: center;

    font-size: 13px;
    color: ${cssVar.colorLink};
    white-space: nowrap;
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
  onSubmitSessionToken: (
    sessionToken: string,
    extras?: { deviceId?: string; sessionChunks?: string[] },
  ) => void;
  submitError?: PasteSubmitError;
  /** Which input the failed submit came from; decides where the error is shown. */
  submitErrorSource?: PasteSubmitSource;
  submitting?: boolean;
  /**
   * The provider connects through the pasted web session ALONE (card flag
   * `oauthDeviceFlow.webSessionOnly`): the authorization page belongs to a different product
   * and the server refuses a callback exchange, so none of that UI may be offered here.
   */
  webSessionOnly?: boolean;
}

/** Where the user signs in; step 1 named it without offering anything to click. */
const CHATGPT_HOME_URL = 'https://chatgpt.com';
/**
 * The one-click fallback. It answers with the account's ACCESS TOKEN and no session cookie
 * (next-auth never echoes an HttpOnly cookie in a body), so a paste from here cannot renew
 * itself — the copy says so, and the live detection repeats it before anything is submitted.
 */
const CHATGPT_SESSION_URL = 'https://chatgpt.com/api/auth/session';

/** Submit errors that belong to the pasted-credential box rather than the callback box. */
const TOKEN_SOURCE_ERRORS = new Set<PasteSubmitError>([
  'accessTokenInvalid',
  'deviceMismatch',
  'sessionInvalid',
  'tokenNotWeb',
]);

/**
 * Rejections whose generic copy sends the user to the authorization page. That page is a dead
 * end for a web-session-only provider — its own server refuses the exchange — so those two get
 * a variant that names the one remedy that works here.
 */
const SESSION_ONLY_ERRORS = new Set<PasteSubmitError>(['accessTokenInvalid', 'tokenNotWeb']);

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
    webSessionOnly,
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
    /**
     * What was pasted, resolved live: a session cookie, a whole "Copy as cURL" command, the
     * JSON body of `/api/auth/session`, or a bare access token. The difference that matters
     * — a web session renews itself, an access token does not — is invisible in the raw
     * text, so it is stated before anything is submitted.
     */
    const parsed = useMemo(() => parseChatGPTWebPaste(pasted), [pasted]);
    const deviceMismatch = parsed.kind === 'device_mismatch';

    const errorSource =
      submitErrorSource ??
      (submitError && TOKEN_SOURCE_ERRORS.has(submitError) ? 'token' : 'callback');
    const tokenError = deviceMismatch
      ? 'deviceMismatch'
      : submitError && errorSource === 'token'
        ? submitError
        : undefined;
    const callbackError = submitError && !tokenError ? submitError : undefined;
    const tokenErrorKey =
      tokenError &&
      `providerModels.config.oauth.paste.errors.${tokenError}${
        webSessionOnly && SESSION_ONLY_ERRORS.has(tokenError) ? 'SessionOnly' : ''
      }`;

    const detection =
      pasted.trim().length === 0
        ? undefined
        : parsed.kind === 'web_session'
          ? 'session'
          : parsed.kind === 'access_token'
            ? 'accessToken'
            : parsed.kind === 'device_mismatch'
              ? undefined
              : 'unknown';

    const handleSubmitCallback = useCallback(() => {
      const value = callbackUrl.trim();
      if (!value) return;
      onSubmitCallback(value);
    }, [callbackUrl, onSubmitCallback]);

    /** Always submit the renewable half when the paste carried both. */
    const handleSubmitPasted = useCallback(() => {
      if (parsed.kind === 'device_mismatch') return;
      if (parsed.sessionToken) {
        onSubmitSessionToken(parsed.sessionToken, {
          ...(parsed.deviceId ? { deviceId: parsed.deviceId } : {}),
          ...(parsed.sessionChunks ? { sessionChunks: parsed.sessionChunks } : {}),
        });
      } else if (parsed.accessToken) onSubmitAccessToken(parsed.accessToken);
    }, [
      onSubmitAccessToken,
      onSubmitSessionToken,
      parsed.accessToken,
      parsed.deviceId,
      parsed.kind,
      parsed.sessionChunks,
      parsed.sessionToken,
    ]);

    /**
     * What to do BEFORE there is anything to paste, as three steps with the pages they name
     * one click away. The cURL route leads because it is a single right-click; the cookie
     * route rides along in the same line for people who prefer it.
     */
    const sessionSteps = (
      <Flexbox gap={4}>
        <Flexbox horizontal align="center" gap={8}>
          <Text className={styles.hint}>{t('providerModels.config.oauth.paste.sessionStep1')}</Text>
          <a
            className={styles.link}
            href={CHATGPT_HOME_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t('providerModels.config.oauth.paste.openChatGPT')}
            <Icon icon={ExternalLinkIcon} size={12} />
          </a>
        </Flexbox>
        <Text className={styles.hint}>{t('providerModels.config.oauth.paste.sessionStep2')}</Text>
        <Text className={styles.hint}>{t('providerModels.config.oauth.paste.sessionStep3')}</Text>
        {/* Secondary on purpose: it trades the whole point of this flow (renewing itself)
            for one click, so it is stated as the compromise it is — never as an equal path. */}
        <Flexbox horizontal align="center" gap={8} style={{ flexWrap: 'wrap' }}>
          <Text className={styles.hint} type="secondary">
            {t('providerModels.config.oauth.paste.sessionQuickTry')}
          </Text>
          <a
            className={styles.link}
            href={CHATGPT_SESSION_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t('providerModels.config.oauth.paste.openSessionPage')}
            <Icon icon={ExternalLinkIcon} size={12} />
          </a>
        </Flexbox>
      </Flexbox>
    );

    /** The pasted-credential input itself: same field, label and live detection either way. */
    const sessionFields = (
      <>
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
        {tokenErrorKey && (
          <Text className={styles.errorText} id={tokenErrorId} role="alert">
            {t(tokenErrorKey as any)}
          </Text>
        )}
      </>
    );

    /**
     * Web-session-only providers get ONE route and it is the primary one. The authorization
     * page is not merely demoted here: it signs the user into a different product, and the
     * server refuses the exchange — so offering it would be offering a dead end.
     */
    if (webSessionOnly)
      return (
        <Flexbox className={styles.panel} gap={16}>
          <Flexbox gap={4}>
            <Text className={styles.label}>
              {t('providerModels.config.oauth.paste.sessionOnlyTitle')}
            </Text>
            <Text className={styles.instruction}>
              {t('providerModels.config.oauth.paste.sessionOnlyDesc')}
            </Text>
          </Flexbox>
          {/* Above the box, because it is what to do BEFORE there is anything to paste. */}
          {sessionSteps}
          <Flexbox gap={8}>{sessionFields}</Flexbox>
          <Flexbox gap={12}>
            <Button
              block
              disabled={disabled || parsed.kind === 'unknown' || parsed.kind === 'device_mismatch'}
              loading={submitting}
              type="primary"
              onClick={handleSubmitPasted}
            >
              {t('providerModels.config.oauth.paste.submit')}
            </Button>
            <Button block size="small" type="text" onClick={onCancel}>
              {t('providerModels.config.oauth.cancel')}
            </Button>
          </Flexbox>
        </Flexbox>
      );

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
                {sessionFields}
                {sessionSteps}
                <Button
                  block
                  loading={submitting}
                  disabled={
                    disabled || parsed.kind === 'unknown' || parsed.kind === 'device_mismatch'
                  }
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
