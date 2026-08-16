'use client';

import { DINGTALK_ALLOWED_CORP_LABEL_MAX_LENGTH } from '@lobechat/types';
import { Alert, Flexbox, Input, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Plus, Trash2 } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { identityProviderStyles as styles } from '../styles';
import type { EditableDraft, PatchDraft } from './types';

interface DingTalkAllowedCorpsFieldProps {
  /** Empty when the capture flow can run; otherwise the reason it cannot. */
  captureBlockedReason: string | null;
  /** Admin-facing explanation when the last capture attempt failed. */
  captureError?: string | null;
  /** Capture flow in progress (DingTalk authorization window is open). */
  capturing: boolean;
  draft: EditableDraft;
  onCapture: () => void;
  patch: PatchDraft;
}

/**
 * Organisation allowlist for a DingTalk login method.
 *
 * Administrators never type a corpId: they launch a real DingTalk login, pick the enterprise in
 * DingTalk's own UI, and the platform captures the organisation id from the token response.
 * Only the human-readable label is editable here.
 */
export const DingTalkAllowedCorpsField = memo<DingTalkAllowedCorpsFieldProps>(
  ({ capturing, captureBlockedReason, captureError, draft, onCapture, patch }) => {
    const { t } = useTranslation('admin');
    const entries = draft.dingtalkAllowedCorps;

    // Held raw while typing (a trailing space before the next word must survive); normalised
    // by `serializeIdentityProviderAllowedCorps` on the way to the API.
    const updateLabel = (corpId: string, label: string) =>
      patch(
        'dingtalkAllowedCorps',
        entries.map((entry) => (entry.corpId === corpId ? { ...entry, label } : entry)),
      );

    const remove = (corpId: string) =>
      patch(
        'dingtalkAllowedCorps',
        entries.filter((entry) => entry.corpId !== corpId),
      );

    return (
      <Flexbox gap={12}>
        <Flexbox gap={4}>
          <Text strong>{t('identityProviders.dingtalk.allowedCorps.title')}</Text>
          <Text type="secondary">{t('identityProviders.dingtalk.allowedCorps.description')}</Text>
        </Flexbox>
        {entries.length === 0 ? (
          <Alert
            showIcon
            description={t('identityProviders.dingtalk.allowedCorps.empty')}
            type="warning"
          />
        ) : (
          <Flexbox gap={8}>
            {entries.map((entry) => (
              <Flexbox
                horizontal
                align="center"
                className={styles.callback}
                gap={8}
                key={entry.corpId}
              >
                <Flexbox flex={1} gap={2}>
                  <Text className={styles.endpointValue}>{entry.corpId}</Text>
                  <Text fontSize={12} type="secondary">
                    {t('identityProviders.dingtalk.allowedCorps.addedAt', {
                      time: new Date(entry.addedAt).toLocaleString(),
                    })}
                  </Text>
                </Flexbox>
                <Input
                  aria-label={t('identityProviders.dingtalk.allowedCorps.label')}
                  maxLength={DINGTALK_ALLOWED_CORP_LABEL_MAX_LENGTH}
                  placeholder={t('identityProviders.dingtalk.allowedCorps.label')}
                  value={entry.label ?? ''}
                  onChange={(e) => updateLabel(entry.corpId, e.target.value)}
                />
                <Button
                  danger
                  aria-label={t('identityProviders.dingtalk.allowedCorps.remove')}
                  icon={Trash2}
                  size="small"
                  onClick={() => remove(entry.corpId)}
                >
                  {t('identityProviders.dingtalk.allowedCorps.remove')}
                </Button>
              </Flexbox>
            ))}
          </Flexbox>
        )}
        <Flexbox gap={6}>
          <Button
            disabled={Boolean(captureBlockedReason)}
            icon={Plus}
            loading={capturing}
            type="primary"
            onClick={onCapture}
          >
            {t('identityProviders.dingtalk.allowedCorps.add')}
          </Button>
          <Text type="secondary">
            {captureBlockedReason ?? t('identityProviders.dingtalk.allowedCorps.addHint')}
          </Text>
          {captureError ? (
            <Alert showIcon description={captureError} role="alert" type="error" />
          ) : null}
        </Flexbox>
      </Flexbox>
    );
  },
);

DingTalkAllowedCorpsField.displayName = 'DingTalkAllowedCorpsField';
