'use client';

import { Flexbox, Icon, Tag, Text, Tooltip } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { cssVar } from 'antd-style';
import { Info } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import { useClientDataSWR } from '@/libs/swr';
import { useUserStore } from '@/store/user';

/** Audit reason recorded for shared-authorization changes from this control. */
const REASON = 'Set org shared OAuth authorization from managed resources';

/**
 * Org shared OAuth designation, shown inside the connectors managed-resource
 * card: while connectors are platform-managed (enforced), every user's
 * OAuth-backed connector calls run with the designated owner's authorizations.
 * Clearing it (or switching managed off) restores per-user authorizations —
 * user rows are never touched.
 */
const SharedOAuthAuthorizationControl = memo<{ disabled?: boolean }>(({ disabled }) => {
  const { t } = useTranslation('admin');
  const myUserId = useUserStore((s) => s.user?.id);
  const [busy, setBusy] = useState(false);
  const { data, mutate } = useClientDataSWR(
    'admin-managed-resources/connector-governance',
    () => adminConnectorsService.getGovernance(),
    { revalidateOnFocus: false },
  );

  const ownerUserId = data?.doc.sharedAuthorization.ownerUserId ?? null;

  const setOwner = (next: string | null) => {
    if (!data) return;
    confirmModal({
      content: next
        ? t('managedResources.sharedOAuth.enableConfirm', {
            defaultValue:
              'Your OAuth authorizations (connector logins) will be used by every user in the organization while connectors are platform-managed. Continue?',
          })
        : t('managedResources.sharedOAuth.disableConfirm', {
            defaultValue:
              'Users will go back to their own OAuth authorizations. No user data is deleted. Continue?',
          }),
      okButtonProps: next ? undefined : { danger: true },
      onOk: async () => {
        setBusy(true);
        try {
          await adminConnectorsService.setSharedAuthorization({
            expectedRevision: data.revision,
            ownerUserId: next,
            reason: REASON,
          });
          await mutate();
          toast.success(
            t('managedResources.sharedOAuth.saved', {
              defaultValue: 'Shared authorization updated',
            }),
          );
        } finally {
          setBusy(false);
        }
      },
      title: t('managedResources.sharedOAuth.title', { defaultValue: 'Org-shared OAuth' }),
    });
  };

  if (!data) return null;

  return (
    <Flexbox gap={6} style={{ marginBlockStart: 10 }}>
      <Flexbox horizontal align="center" gap={8} justify="space-between">
        <Flexbox horizontal align="center" gap={6}>
          <Text strong style={{ fontSize: 13 }}>
            {t('managedResources.sharedOAuth.title', { defaultValue: 'Org-shared OAuth' })}
          </Text>
          <Tooltip
            title={t('managedResources.sharedOAuth.activeDesc', {
              defaultValue:
                'While connectors are platform-managed, all users share the designated OAuth authorizations. User-owned authorizations are kept and resume when sharing stops.',
            })}
          >
            <span
              style={{ color: cssVar.colorTextSecondary, cursor: 'help', display: 'inline-flex' }}
            >
              <Icon icon={Info} size={14} />
            </span>
          </Tooltip>
          {ownerUserId ? (
            <Tag color="success">
              {t('managedResources.sharedOAuth.active', { defaultValue: 'Shared' })}
            </Tag>
          ) : (
            <Tag>{t('managedResources.sharedOAuth.perUser', { defaultValue: 'Per user' })}</Tag>
          )}
        </Flexbox>
        {ownerUserId ? (
          <Button
            danger
            disabled={disabled}
            loading={busy}
            size="small"
            onClick={() => setOwner(null)}
          >
            {t('managedResources.sharedOAuth.clear', { defaultValue: 'Stop sharing' })}
          </Button>
        ) : (
          <Button
            disabled={disabled || !myUserId}
            loading={busy}
            size="small"
            onClick={() => setOwner(myUserId ?? null)}
          >
            {t('managedResources.sharedOAuth.enable', {
              defaultValue: 'Share my authorizations',
            })}
          </Button>
        )}
      </Flexbox>
    </Flexbox>
  );
});

SharedOAuthAuthorizationControl.displayName = 'SharedOAuthAuthorizationControl';

export default SharedOAuthAuthorizationControl;
