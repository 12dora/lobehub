'use client';

import { parseChatGPTWebPaste } from '@lobechat/utils/chatgptWebPaste';
import { Flexbox, Icon, Text } from '@lobehub/ui';
import { Button, TextArea } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { ExternalLinkIcon } from 'lucide-react';
import { memo, useCallback, useId, useMemo, useState } from 'react';
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
  /** Provider accepts a pasted credential (web session or access token) as well. */
  allowAccessTokenPaste?: boolean;
  authorizeUri: string;
  /**
   * Open the pasted-credential section immediately. Set when the operator arrived here from
   * the "this connection cannot renew itself" warning: the fix they clicked IS that section,
   * so making them find it again would be the whole failure repeated.
   */
  defaultSessionOpen?: boolean;
  onCancel: () => void;
  onOpenAuthorizePage: () => void;
  onRegenerate: () => void;
  onSubmitAccessToken: (accessToken: string) => void;
  onSubmitCallback: (callbackUrl: string) => void;
  onSubmitSessionToken: (sessionToken: string) => void;
  submitError?: SharedOAuthPasteError;
  /** Which input the failed submit came from; decides where the error is shown. */
  submitErrorSource?: SharedOAuthPasteSource;
  submitting?: boolean;
}

/** Submit errors that belong to the pasted-credential box rather than the callback box. */
const TOKEN_SOURCE_ERRORS = new Set<SharedOAuthPasteError>([
  'accessTokenInvalid',
  'sessionInvalid',
  'tokenNotWeb',
]);

/**
 * Shared-account variant of the authorization-code paste flow: the operator signs in as the
 * ONE platform account in a browser, then brings the callback URL back here. No polling —
 * the provider's redirect URI never reaches this deployment.
 */
const SharedOAuthPasteForm = memo<SharedOAuthPasteFormProps>(
  ({
    allowAccessTokenPaste,
    authorizeUri,
    defaultSessionOpen,
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
    const { t } = useTranslation('admin');
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
     * not paint the callback box red, or the operator fixes the wrong thing.
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
     * What the operator actually pasted, resolved live: a session cookie, a whole "Copy as
     * cURL" command, the JSON body of `/api/auth/session`, or a bare access token. Saying so
     * BEFORE the submit is the point — a web session renews itself and an access token does
     * not, and that difference is invisible in the raw text.
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
          autoCapitalize={'none'}
          // A live authorization code: never autofilled, never corrected, and never handed
          // to a spellchecker that may ship it off-device.
          autoComplete={'off'}
          autoCorrect={'off'}
          autoSize={{ maxRows: 4, minRows: 2 }}
          id={callbackFieldId}
          placeholder={t('aiProviderSettings.sharedOAuth.paste.callbackPlaceholder')}
          spellCheck={false}
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
                {t('aiProviderSettings.sharedOAuth.paste.sessionToggle')}
              </Button>
            </Flexbox>
            {showTokenSection && (
              <Flexbox gap={8} id={tokenSectionId}>
                <label className={styles.label} htmlFor={tokenFieldId}>
                  {t('aiProviderSettings.sharedOAuth.paste.sessionLabel')}
                </label>
                <TextArea
                  aria-invalid={tokenError ? true : undefined}
                  autoCapitalize={'none'}
                  // A raw session cookie: no autofill, no autocorrect mangling it, and no
                  // spellchecker — which on several platforms means uploading it.
                  autoComplete={'off'}
                  autoCorrect={'off'}
                  autoSize={{ maxRows: 6, minRows: 3 }}
                  id={tokenFieldId}
                  placeholder={t('aiProviderSettings.sharedOAuth.paste.sessionPlaceholder')}
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
                    // Live, because it changes while the operator types into the box above.
                    role={'status'}
                    type={detection === 'session' ? 'secondary' : 'warning'}
                  >
                    {t(`aiProviderSettings.sharedOAuth.paste.detected.${detection}` as any)}
                  </Text>
                )}
                {tokenError && (
                  <Text className={styles.error} id={tokenErrorId} role={'alert'}>
                    {t(`aiProviderSettings.sharedOAuth.paste.errors.${tokenError}` as any)}
                  </Text>
                )}
                <Text className={styles.hint}>
                  {t('aiProviderSettings.sharedOAuth.paste.sessionHint')}
                </Text>
                <Flexbox horizontal>
                  <Button
                    disabled={parsed.kind === 'unknown'}
                    loading={submitting}
                    onClick={handleSubmitPasted}
                  >
                    {t('aiProviderSettings.sharedOAuth.paste.sessionSubmit')}
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
