'use client';

import { Alert, Text } from '@lobehub/ui';
import { memo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';

/**
 * Dedicated surface for applyImmediate dirty-draft rejection.
 * AutoSaveHint alone is insufficient (retry would loop without guidance).
 */
const DirtyDraftAlert = memo<{ onDismiss?: () => void }>(({ onDismiss }) => {
  const { t } = useTranslation('admin');

  return (
    <Alert
      showIcon
      closable={Boolean(onDismiss)}
      message={t('aiSettingsDefaults.dirtyDraft.title')}
      type="warning"
      description={
        <Text as="div" style={{ fontSize: 13 }}>
          <Trans
            i18nKey="aiSettingsDefaults.dirtyDraft.desc"
            ns="admin"
            components={{
              settingsLink: <Link to="/admin/settings" />,
            }}
          />
        </Text>
      }
      onClose={onDismiss}
    />
  );
});

DirtyDraftAlert.displayName = 'DirtyDraftAlert';

export default DirtyDraftAlert;
