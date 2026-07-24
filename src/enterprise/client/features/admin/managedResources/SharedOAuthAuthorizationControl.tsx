'use client';

import { Flexbox, Icon, Tag, Text, Tooltip } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { cssVar } from 'antd-style';
import debug from 'debug';
import { Info } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import { useClientDataSWR } from '@/libs/swr';
import { useUserStore } from '@/store/user';

import { SHARED_OAUTH_AUTO_REASON } from './auditReasonCodes';

const log = debug('lobe-client:admin:connectors');

interface SharedOAuthAuthorizationControlProps {
  /** CONNECTOR_READ — gates the governance fetch. */
  canRead?: boolean;
  /** CONNECTOR_UPDATE — gates enable/clear actions. */
  canUpdate?: boolean;
  /** Parent busy (e.g. policy save in flight). */
  disabled?: boolean;
}

/**
 * Org shared OAuth designation, shown inside the connectors managed-resource
 * card: while connectors are platform-managed (enforced), every user's
 * OAuth-backed connector calls run with the designated owner's authorizations.
 * Clearing it (or switching managed off) restores per-user authorizations —
 * user rows are never touched.
 */
const SharedOAuthAuthorizationControl = memo<SharedOAuthAuthorizationControlProps>(
  ({ canRead = true, canUpdate = false, disabled }) => {
    const { t } = useTranslation('admin');
    const myUserId = useUserStore((s) => s.user?.id);
    const [busy, setBusy] = useState(false);
    const { data, error, isLoading, mutate } = useClientDataSWR(
      canRead ? 'admin-managed-resources/connector-governance' : null,
      () => adminConnectorsService.getGovernance(),
      { revalidateOnFocus: false },
    );

    if (!canRead) return null;

    if (isLoading && !data && !error) {
      return (
        <Text style={{ fontSize: 12, marginBlockStart: 10 }} type="secondary">
          {t('primitives.dataTable.loading')}
        </Text>
      );
    }

    if (error && !data) {
      return (
        <Flexbox gap={6} role="alert" style={{ marginBlockStart: 10 }}>
          <Text style={{ fontSize: 12 }} type="danger">
            {t('managedResources.sharedOAuth.loadError', {
              defaultValue: 'Could not load shared OAuth status.',
            })}
          </Text>
          <Button size="small" type="default" onClick={() => void mutate()}>
            {t('primitives.dataTable.retry')}
          </Button>
        </Flexbox>
      );
    }

    if (!data) return null;

    const ownerUserId = data.doc.sharedAuthorization.ownerUserId ?? null;
    const actionsDisabled = disabled || busy || !canUpdate;

    const setOwner = (next: string | null) => {
      if (!canUpdate) return;
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
            // Commit boundary: mutation success is authoritative; cache refresh is best-effort.
            await adminConnectorsService.setSharedAuthorization({
              expectedRevision: data.revision,
              ownerUserId: next,
              reason: SHARED_OAUTH_AUTO_REASON,
            });
            try {
              await mutate();
            } catch (refreshError) {
              log('post-setSharedAuthorization refresh failed: %O', refreshError);
              toast.success(
                t('managedResources.sharedOAuth.savedRefreshFailed', {
                  defaultValue: 'Shared authorization updated, but the view could not refresh.',
                }),
              );
              return;
            }
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
              disabled={actionsDisabled}
              loading={busy}
              size="small"
              onClick={() => setOwner(null)}
            >
              {t('managedResources.sharedOAuth.clear', { defaultValue: 'Stop sharing' })}
            </Button>
          ) : (
            <Button
              disabled={actionsDisabled || !myUserId}
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
  },
);

SharedOAuthAuthorizationControl.displayName = 'SharedOAuthAuthorizationControl';

export default SharedOAuthAuthorizationControl;
