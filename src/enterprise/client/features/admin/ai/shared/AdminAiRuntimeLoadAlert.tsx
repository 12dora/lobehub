'use client';

import { Alert } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

export interface AdminAiRuntimeLoadAlertProps {
  error: unknown;
  onRetry: () => Promise<unknown>;
}

/**
 * Visible error + retry for admin AI runtime catalog SWR failures (AI-07).
 * Maps typed enterprise errors to localized copy; falls back to a generic load message.
 */
const AdminAiRuntimeLoadAlert = memo<AdminAiRuntimeLoadAlertProps>(({ error, onRetry }) => {
  const { t } = useTranslation('admin');
  const [retrying, setRetrying] = useState(false);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    try {
      await onRetry();
    } catch {
      // Keep the alert visible; do not rethrow through the void click handler.
    } finally {
      setRetrying(false);
    }
  }, [onRetry]);

  if (!error) return null;

  const mapped = mapEnterpriseError(error);
  const count =
    mapped?.details &&
    typeof mapped.details === 'object' &&
    typeof mapped.details.count === 'number'
      ? mapped.details.count
      : undefined;
  const message = mapped
    ? t(mapped.i18nKey as never, {
        count,
        defaultValue: mapped.code,
      })
    : t('aiInfraError.runtimeLoadFailed');

  return (
    <Alert
      showIcon
      closable={false}
      message={message}
      style={{ marginBottom: 12 }}
      type="error"
      action={
        <Button loading={retrying} size="small" onClick={() => void handleRetry()}>
          {t('aiInfraError.retry')}
        </Button>
      }
    />
  );
});

AdminAiRuntimeLoadAlert.displayName = 'AdminAiRuntimeLoadAlert';

export default AdminAiRuntimeLoadAlert;
