'use client';

import {
  DINGTALK_ALLOWED_CORP_LABEL_MAX_LENGTH,
  DINGTALK_CORP_NAME_MAX_LENGTH,
} from '@lobechat/types';
import { Alert, Flexbox, Input, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Plus, Trash2 } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type IdentityProviderCallbackUrls,
  resolveIdentityProviderCallbackUrls,
} from '../controller';
import { identityProviderStyles as styles } from '../styles';
import type { EditableDraft, PatchDraft } from './types';

interface DingTalkAllowedCorpsFieldProps {
  /** Redirect URLs that must be registered in the DingTalk Open Platform. */
  callbacks?: IdentityProviderCallbackUrls;
  /** Empty when the capture flow can run; otherwise the reason it cannot. */
  captureBlockedReason: string | null;
  /** Admin-facing explanation when the last capture attempt failed. */
  captureError?: string | null;
  /** Capture flow in progress (DingTalk authorization window is open). */
  capturing: boolean;
  draft: EditableDraft;
  onCapture: () => void;
  onCopyUrl?: (url: string) => void;
  patch: PatchDraft;
}

/**
 * Organisation allowlist for a DingTalk login method.
 *
 * Administrators never type a corpId: they launch a real DingTalk login, pick the enterprise in
 * DingTalk's own UI, and the platform captures the organisation id from the token response.
 * The organisation name and the human-readable note are editable here.
 */
export const DingTalkAllowedCorpsField = memo<DingTalkAllowedCorpsFieldProps>(
  ({
    callbacks,
    capturing,
    captureBlockedReason,
    captureError,
    draft,
    onCapture,
    onCopyUrl,
    patch,
  }) => {
    const { t } = useTranslation('admin');
    const entries = draft.dingtalkAllowedCorps;
    const callbackUrls = resolveIdentityProviderCallbackUrls(callbacks, draft);

    // Held raw while typing (a trailing space before the next word must survive); normalised
    // by `serializeIdentityProviderAllowedCorps` on the way to the API.
    const updateLabel = (corpId: string, label: string) =>
      patch(
        'dingtalkAllowedCorps',
        entries.map((entry) => (entry.corpId === corpId ? { ...entry, label } : entry)),
      );

    const updateCorpName = (corpId: string, corpName: string) =>
      patch(
        'dingtalkAllowedCorps',
        entries.map((entry) => (entry.corpId === corpId ? { ...entry, corpName } : entry)),
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
          <div className={styles.corpTable} role="table">
            <div className={styles.corpTableHead} role="row">
              <span role="columnheader">
                {t('identityProviders.dingtalk.allowedCorps.columns.organization')}
              </span>
              <span role="columnheader">
                {t('identityProviders.dingtalk.allowedCorps.columns.added')}
              </span>
              <span role="columnheader">{t('identityProviders.dingtalk.allowedCorps.label')}</span>
              <span role="columnheader" />
            </div>
            {entries.map((entry) => (
              <div className={styles.corpTableRow} key={entry.corpId} role="row">
                <Flexbox gap={2} role="cell" style={{ minWidth: 0 }}>
                  <Input
                    aria-label={t('identityProviders.dingtalk.allowedCorps.columns.organization')}
                    maxLength={DINGTALK_CORP_NAME_MAX_LENGTH}
                    placeholder={t('identityProviders.dingtalk.allowedCorps.unnamed')}
                    size="small"
                    value={entry.corpName ?? ''}
                    onChange={(e) => updateCorpName(entry.corpId, e.target.value)}
                  />
                  <span className={styles.corpId} title={entry.corpId}>
                    {entry.corpId}
                  </span>
                </Flexbox>
                <Text fontSize={12} role="cell" type="secondary">
                  {new Date(entry.addedAt).toLocaleString()}
                </Text>
                <div role="cell">
                  <Input
                    aria-label={t('identityProviders.dingtalk.allowedCorps.label')}
                    maxLength={DINGTALK_ALLOWED_CORP_LABEL_MAX_LENGTH}
                    placeholder={t('identityProviders.dingtalk.allowedCorps.label')}
                    size="small"
                    value={entry.label ?? ''}
                    onChange={(e) => updateLabel(entry.corpId, e.target.value)}
                  />
                </div>
                <div role="cell">
                  <Button
                    danger
                    aria-label={t('identityProviders.dingtalk.allowedCorps.remove')}
                    icon={Trash2}
                    size="small"
                    onClick={() => remove(entry.corpId)}
                  >
                    {t('identityProviders.dingtalk.allowedCorps.remove')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
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
          {/* Every capture failure points at these two URLs, so they are readable right here
              instead of one step away. */}
          {(
            [
              ['production', callbackUrls.production],
              ['test', callbackUrls.test],
            ] as const
          ).map(([key, url]) => (
            <Flexbox gap={2} key={key}>
              <Text fontSize={12} type="secondary">
                {t(`identityProviders.callback.${key}` as never)}
              </Text>
              <div className={styles.callback}>
                <span className={styles.callbackUrl}>{url ?? '—'}</span>
                {url ? (
                  <Button size="small" onClick={() => onCopyUrl?.(url)}>
                    {t('identityProviders.callback.copy')}
                  </Button>
                ) : null}
              </div>
            </Flexbox>
          ))}
        </Flexbox>
      </Flexbox>
    );
  },
);

DingTalkAllowedCorpsField.displayName = 'DingTalkAllowedCorpsField';
