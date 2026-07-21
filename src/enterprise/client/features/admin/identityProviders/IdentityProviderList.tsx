'use client';

import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { cx } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import StatusBadge from '../primitives/StatusBadge';
import { toIdentityProviderStatusBadge } from './controller';
import { identityProviderStyles as styles } from './styles';

interface IdentityProviderListProps {
  canCreate: boolean;
  items: PlatformIdentityProviderDraft[];
  onCreate: () => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
}

const IdentityProviderList = memo<IdentityProviderListProps>(
  ({ canCreate, items, onCreate, onSelect, selectedId }) => {
    const { t } = useTranslation('admin');

    if (items.length === 0) {
      return (
        <div className={styles.card} data-testid="identity-provider-empty">
          <Text strong>{t('identityProviders.empty')}</Text>
          <Text type="secondary">{t('identityProviders.emptyHint')}</Text>
          {canCreate ? (
            <Button style={{ alignSelf: 'flex-start' }} type="primary" onClick={onCreate}>
              {t('identityProviders.actions.create')}
            </Button>
          ) : null}
        </div>
      );
    }

    return (
      <div className={styles.list} data-testid="identity-provider-list">
        {items.map((provider) => {
          const active = selectedId === provider.id;
          return (
            <button
              className={cx(styles.card, styles.cardButton, active && styles.cardActive)}
              key={provider.id}
              type="button"
              onClick={() => onSelect(provider.id)}
            >
              <Flexbox horizontal align="flex-start" gap={8} justify="space-between">
                <Text strong>{provider.displayName}</Text>
                <StatusBadge status={toIdentityProviderStatusBadge(provider.status)} />
              </Flexbox>
              <Text className={styles.meta} type="secondary">
                {provider.providerKey}
              </Text>
              <Flexbox horizontal gap={6} wrap="wrap">
                <Tag color={provider.type === 'authentik' ? 'blue' : 'default'}>
                  {provider.type === 'authentik'
                    ? 'Authentik'
                    : t('identityProviders.templates.genericOidc.label')}
                </Tag>
                <Tag>
                  {t('identityProviders.list.currentRevision', { revision: provider.revision })}
                </Tag>
                <Tag>
                  {t('identityProviders.list.activationRevision', {
                    revision: provider.activationRevision ?? '—',
                  })}
                </Tag>
              </Flexbox>
            </button>
          );
        })}
      </div>
    );
  },
);

IdentityProviderList.displayName = 'IdentityProviderList';
export default IdentityProviderList;
