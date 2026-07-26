'use client';

import { Alert, Flexbox, Icon, Tag, Text, Tooltip } from '@lobehub/ui';
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

/**
 * Commit boundary for setSharedAuthorization: mutation success is authoritative;
 * SWR refresh failure must not reject the overall operation.
 * Exported for focused unit tests (production path uses the same helper).
 */
export const commitSharedOAuthThenRefresh = async (params: {
  mutate: () => Promise<unknown>;
  setSharedAuthorization: () => Promise<void>;
}): Promise<{ committed: true; refreshFailed: boolean }> => {
  await params.setSharedAuthorization();
  try {
    await params.mutate();
    return { committed: true, refreshFailed: false };
  } catch (refreshError) {
    log('post-setSharedAuthorization refresh failed: %O', refreshError);
    return { committed: true, refreshFailed: true };
  }
};

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
    const [refreshFailed, setRefreshFailed] = useState(false);
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
    // A successful mutation followed by a failed refresh leaves the rendered
    // revision stale. Only a refresh retry is safe until current state arrives.
    const actionsDisabled = disabled || busy || refreshFailed || !canUpdate;

    const setOwner = (next: string | null) => {
      if (!canUpdate || refreshFailed) return;
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
            const { refreshFailed } = await commitSharedOAuthThenRefresh({
              mutate: () => mutate(),
              setSharedAuthorization: async () => {
                await adminConnectorsService.setSharedAuthorization({
                  expectedRevision: data.revision,
                  ownerUserId: next,
                  reason: SHARED_OAUTH_AUTO_REASON,
                });
              },
            });
            if (refreshFailed) {
              setRefreshFailed(true);
              toast.warning(t('managedResources.sharedOAuth.savedRefreshFailed'));
              return;
            }
            setRefreshFailed(false);
            toast.success(
              t('managedResources.sharedOAuth.saved', {
                defaultValue: 'Shared authorization updated',
              }),
            );
          } catch (cause) {
            log('setSharedAuthorization failed: %O', cause);
            toast.error(
              t('managedResources.sharedOAuth.mutationFailed', {
                defaultValue: 'Shared authorization could not be updated. Try again.',
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
        {refreshFailed ? (
          <Alert
            showIcon
            message={t('managedResources.sharedOAuth.savedRefreshFailed')}
            type="warning"
            extra={
              <Button
                size="small"
                onClick={async () => {
                  try {
                    await mutate();
                    setRefreshFailed(false);
                  } catch (cause) {
                    log('shared OAuth retry refresh failed: %O', cause);
                    toast.error(t('managedResources.sharedOAuth.refreshRetryFailed'));
                  }
                }}
              >
                {t('managedResources.sharedOAuth.refreshRetry')}
              </Button>
            }
          />
        ) : null}
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
