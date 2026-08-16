import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { TableColumnsType } from 'antd';
import type { TFunction } from 'i18next';

import IdentityProviderStatusBadge from './IdentityProviderStatusBadge';

export const buildIdentityProviderColumns = (
  t: TFunction,
): TableColumnsType<PlatformIdentityProviderDraft> => [
  {
    key: 'name',
    title: t('identityProviders.columns.name'),
    render: (_, item) => (
      <Flexbox gap={2}>
        <Text strong>{item.displayName}</Text>
        <Text ellipsis style={{ fontSize: 12 }} type="secondary">
          {item.buttonLabel}
        </Text>
      </Flexbox>
    ),
  },
  {
    key: 'type',
    title: t('identityProviders.columns.type'),
    width: 160,
    render: (_, item) => (
      <Tag color={item.type === 'generic_oidc' ? 'default' : 'blue'}>
        {item.type === 'authentik'
          ? 'Authentik'
          : item.type === 'dingtalk'
            ? t('identityProviders.templates.dingtalk.label')
            : t('identityProviders.templates.genericOidc.label')}
      </Tag>
    ),
  },
  {
    dataIndex: 'status',
    key: 'status',
    title: t('identityProviders.columns.status'),
    width: 150,
    render: (_, item) => <IdentityProviderStatusBadge provider={item} />,
  },
];

export const buildIdentityProviderActionsColumn = ({
  canDelete,
  canDisable,
  isDeletable,
  isDisableable,
  requestDelete,
  requestDisable,
  t,
}: {
  canDelete: boolean;
  canDisable: boolean;
  isDeletable: (provider: PlatformIdentityProviderDraft) => boolean;
  isDisableable: (provider: PlatformIdentityProviderDraft) => boolean;
  requestDelete: (provider: PlatformIdentityProviderDraft) => void;
  requestDisable: (provider: PlatformIdentityProviderDraft) => void;
  t: TFunction;
}): TableColumnsType<PlatformIdentityProviderDraft>[number] =>
  ({
    key: 'actions',
    title: t('identityProviders.columns.actions', { defaultValue: 'Actions' }),
    width: 140,
    render: (_: unknown, item: PlatformIdentityProviderDraft) => {
      if (canDisable && isDisableable(item)) {
        return (
          <Button
            danger
            size="small"
            onClick={(event) => {
              event.stopPropagation();
              requestDisable(item);
            }}
          >
            {t('identityProviders.actions.disable', { defaultValue: 'Disable' })}
          </Button>
        );
      }
      if (canDelete && isDeletable(item)) {
        return (
          <Button
            danger
            size="small"
            onClick={(event) => {
              event.stopPropagation();
              requestDelete(item);
            }}
          >
            {t('identityProviders.actions.delete')}
          </Button>
        );
      }
      return null;
    },
  }) as TableColumnsType<PlatformIdentityProviderDraft>[number];
