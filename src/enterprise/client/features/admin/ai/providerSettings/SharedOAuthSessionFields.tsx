'use client';

import { Text } from '@lobehub/ui';
import { TextArea } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { SharedOAuthPasteError } from './useAdminSharedOAuthFlow';

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
}));

type SessionDetection = 'session' | 'accessToken' | 'unknown';

interface SharedOAuthSessionFieldsProps {
  detection?: SessionDetection;
  detectionId: string;
  onChange: (value: string) => void;
  tokenError?: SharedOAuthPasteError;
  tokenErrorId: string;
  tokenErrorKey?: string;
  tokenFieldId: string;
  value: string;
}

/** The pasted-credential input itself: same field, label and live detection either way. */
const SharedOAuthSessionFields = memo<SharedOAuthSessionFieldsProps>(
  ({
    detection,
    detectionId,
    onChange,
    tokenError,
    tokenErrorId,
    tokenErrorKey,
    tokenFieldId,
    value,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <>
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
          value={value}
          aria-describedby={
            [tokenError ? tokenErrorId : undefined, detection ? detectionId : undefined]
              .filter(Boolean)
              .join(' ') || undefined
          }
          onChange={(e) => onChange(e.target.value)}
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
        {tokenErrorKey && (
          <Text className={styles.error} id={tokenErrorId} role={'alert'}>
            {t(tokenErrorKey as any)}
          </Text>
        )}
      </>
    );
  },
);

SharedOAuthSessionFields.displayName = 'AdminSharedOAuthSessionFields';

export default SharedOAuthSessionFields;
