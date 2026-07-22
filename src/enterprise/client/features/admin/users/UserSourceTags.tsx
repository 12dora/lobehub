'use client';

import { Flexbox, Tag, Tooltip } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { deriveUserSources } from './utils';

export interface UserSourceTagsProps {
  /** Better Auth account provider ids for the user. */
  providerIds: readonly string[];
}

/**
 * Local / SSO source tags derived from provider ids.
 * SSO tag tooltip lists concrete non-credential provider ids.
 */
const UserSourceTags = memo<UserSourceTagsProps>(({ providerIds }) => {
  const { t } = useTranslation('admin');
  const { hasLocal, hasSso, ssoProviderIds } = deriveUserSources(providerIds);

  if (!hasLocal && !hasSso) return '—';

  return (
    <Flexbox horizontal gap={4} style={{ flexWrap: 'wrap' }}>
      {hasLocal ? (
        <Tag data-testid="user-source-local" size="small">
          {t('users.source.local')}
        </Tag>
      ) : null}
      {hasSso ? (
        <Tooltip title={t('users.source.ssoTooltip', { providers: ssoProviderIds.join(', ') })}>
          <Tag data-testid="user-source-sso" size="small">
            {t('users.source.sso')}
          </Tag>
        </Tooltip>
      ) : null}
    </Flexbox>
  );
});

UserSourceTags.displayName = 'AdminUserSourceTags';

export default UserSourceTags;
