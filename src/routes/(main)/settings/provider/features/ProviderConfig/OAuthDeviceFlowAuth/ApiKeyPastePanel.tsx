'use client';

import { Flexbox, Icon } from '@lobehub/ui';
import { Button, InputPassword } from '@lobehub/ui/base-ui';
import { Typography } from 'antd';
import { createStaticStyles } from 'antd-style';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

const { Text } = Typography;

const styles = createStaticStyles(({ css, cssVar }) => ({
  error: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorError};
  `,
  hint: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextDescription};
  `,
  label: css`
    font-size: ${cssVar.fontSizeSM};
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  section: css`
    width: 100%;
  `,
}));

interface ApiKeyPastePanelProps {
  /** Where this provider's keys are created; linked from the hint when the card names one. */
  apiKeyUrl?: string;
  /** Opens the disclosure on mount — used after a failed submit, so the box stays put. */
  defaultOpen?: boolean;
  disabled?: boolean;
  /** Display name of the provider — the dashboard the key is created in. */
  name: string;
  /**
   * Abandon the pending connect attempt. Offered only while one is running: this route hides
   * a real round trip (an envelope request, then the exchange) behind one button, and a
   * provider that stalls on it must never be a dead end.
   */
  onCancel?: () => void;
  onSubmit: (apiKey: string) => void;
  /** A submit failed; the box stays open so the key can be corrected in place. */
  submitFailed?: boolean;
  submitting?: boolean;
}

/**
 * Second connect route for a provider whose pasted credential is a dashboard API KEY (card
 * flag `oauthDeviceFlow.pastedCredentialKind: 'apiKey'`, today: Cursor) rather than an
 * access token.
 *
 * It stands next to the browser login, not instead of it, and it is the durable one: the
 * server exchanges the key for a session and keeps renewing from it, so this connection
 * never asks for another sign-in. Behind a disclosure — the browser login stays the
 * one-click default — and offered from the idle card as well, so holding a key never means
 * starting (and abandoning) a browser login just to find this box.
 *
 * No shape validation: only the provider knows what its keys look like, so a regex that
 * guesses would reject valid ones. Trimmed and non-empty is the whole client-side contract.
 */
const ApiKeyPastePanel = memo<ApiKeyPastePanelProps>(
  ({
    apiKeyUrl,
    defaultOpen = false,
    disabled,
    name,
    onCancel,
    onSubmit,
    submitFailed,
    submitting,
  }) => {
    const { t } = useTranslation('modelProvider');
    const [open, setOpen] = useState(defaultOpen);
    const [apiKey, setApiKey] = useState('');
    const fieldGroupId = useId();
    const fieldId = `${fieldGroupId}-api-key`;
    const errorId = `${fieldGroupId}-api-key-error`;
    const sectionId = `${fieldGroupId}-api-key-section`;

    // A failure has to be visible next to the field that caused it: a closed disclosure would
    // report the error nowhere at all.
    useEffect(() => {
      if (submitFailed) setOpen(true);
    }, [submitFailed]);

    const handleSubmit = useCallback(() => {
      const value = apiKey.trim();
      if (!value) return;
      onSubmit(value);
    }, [apiKey, onSubmit]);

    return (
      <Flexbox className={styles.section} gap={8}>
        <Flexbox horizontal justify={'center'}>
          <Button
            aria-controls={sectionId}
            aria-expanded={open}
            disabled={disabled}
            // A disclosure, not a tab: without the chevron the open state read as a selected
            // segment, and the label alone did not say it opened anything.
            icon={<Icon icon={open ? ChevronDown : ChevronRight} size={14} />}
            size={'small'}
            type={'text'}
            onClick={() => setOpen((value) => !value)}
          >
            {t('providerModels.config.oauth.paste.apiKeyToggle')}
          </Button>
        </Flexbox>
        {open && (
          <Flexbox gap={8} id={sectionId}>
            <label className={styles.label} htmlFor={fieldId}>
              {t('providerModels.config.oauth.paste.apiKeyLabel')}
            </label>
            {/* A live credential on a shared screen: masked by default, one line, and never
                offered to autofill, autocorrect or a spellchecker that may ship it away. */}
            <InputPassword
              aria-describedby={submitFailed ? errorId : undefined}
              aria-invalid={submitFailed ? true : undefined}
              autoCapitalize={'none'}
              autoComplete={'off'}
              autoCorrect={'off'}
              disabled={disabled}
              id={fieldId}
              placeholder={t('providerModels.config.oauth.paste.apiKeyPlaceholder', { name })}
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <Text className={styles.hint}>
              {apiKeyUrl ? (
                <Trans
                  i18nKey="providerModels.config.oauth.paste.apiKeyHintWithUrl"
                  ns={'modelProvider'}
                  values={{ name }}
                  components={[
                    <span key="0" />,
                    <a href={apiKeyUrl} key="1" rel={'noreferrer'} target={'_blank'} />,
                  ]}
                />
              ) : (
                t('providerModels.config.oauth.paste.apiKeyHint', { name })
              )}
            </Text>
            {submitFailed && (
              <Text className={styles.error} id={errorId} role={'alert'}>
                {t('providerModels.config.oauth.paste.apiKeyError')}
              </Text>
            )}
            <Flexbox horizontal gap={8}>
              <Button
                disabled={disabled || !apiKey.trim()}
                loading={submitting}
                onClick={handleSubmit}
              >
                {t('providerModels.config.oauth.paste.apiKeySubmit')}
              </Button>
              {submitting && onCancel && (
                <Button type={'text'} onClick={onCancel}>
                  {t('providerModels.config.oauth.cancel')}
                </Button>
              )}
            </Flexbox>
          </Flexbox>
        )}
      </Flexbox>
    );
  },
);

ApiKeyPastePanel.displayName = 'ApiKeyPastePanel';

export default ApiKeyPastePanel;
