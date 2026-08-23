'use client';

import { Text } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

const styles = createStaticStyles(({ css, cssVar }) => ({
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
}));

/**
 * Managed-resources tab of the unified admin page: the ONLY place where the shared
 * catalog is handed to members ("Platform managed").
 */
const MANAGED_RESOURCES_PATH = '/admin/unified?tab=managed';

interface SharedOAuthEnforcementHintProps {
  visible: boolean;
}

/**
 * A connected account is not the same as an account members use. This says so, and points
 * at the one page that changes it. Rendered in BOTH the just-connected view and the idle
 * connected view — the moment right after connecting is exactly when an operator concludes
 * "done", so leaving it out there was the whole gap.
 */
const SharedOAuthEnforcementHint = memo<SharedOAuthEnforcementHintProps>(({ visible }) => {
  const { t } = useTranslation('admin');

  if (!visible) return null;

  return (
    <Text className={styles.hint}>
      {t('aiProviderSettings.sharedOAuth.enforcementHint')}{' '}
      <Link to={MANAGED_RESOURCES_PATH}>
        {t('aiProviderSettings.sharedOAuth.enforcementHintLink')}
      </Link>
    </Text>
  );
});

SharedOAuthEnforcementHint.displayName = 'AdminSharedOAuthEnforcementHint';

export default SharedOAuthEnforcementHint;
