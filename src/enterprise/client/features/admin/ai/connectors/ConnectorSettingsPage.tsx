'use client';

import { Center, Empty, Flexbox, SearchBar, Tag, Text } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Plug } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import NavItem from '@/features/NavPanel/components/NavItem';

import { deriveAdminConnectorPermissions } from '../../connectors/controller';
import { openCreateConnectorModal } from '../../connectors/openCreateConnectorModal';
import type { AdminConnectorListItem } from '../../connectors/types';
import {
  refreshAdminConnectorLists,
  useFetchAdminConnector,
  useFetchAdminConnectors,
} from '../../connectors/useMockableAdminConnectorCatalog';
import DraftPublishBanner from './DraftPublishBanner';

const styles = createStaticStyles(({ css }) => ({
  advancedLink: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-decoration: none;

    &:hover {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  body: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    min-height: 0;
  `,
  card: css`
    display: grid;
    grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
    gap: 10px 16px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
  `,
  content: css`
    overflow: auto;
    flex: 1;
    min-width: 0;
  `,
  detailBody: css`
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 24px;
  `,
  detailHeader: css`
    display: flex;
    flex-direction: column;
    gap: 6px;

    padding-block: 20px 16px;
    padding-inline: 24px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  left: css`
    overflow: hidden;
    display: flex;
    flex-direction: column;

    width: 300px;
    min-width: 260px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  leftBody: css`
    overflow-y: auto;
    flex: 1;
    padding-block: 4px;
    padding-inline: 8px;
  `,
  leftHeader: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    height: 42px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  shell: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  `,
  toolbar: css`
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 8px 12px;
    padding-inline: 4px;
  `,
  tools: css`
    overflow: auto;
    max-height: 240px;
  `,
}));

const ConnectorListItem = memo<{
  connector: AdminConnectorListItem;
  isSelected: boolean;
  onSelect: () => void;
}>(({ connector, isSelected, onSelect }) => (
  <NavItem active={isSelected} icon={Plug} title={connector.displayName} onClick={onSelect} />
));

const ConnectorDetailPanel = memo<{
  connectorId: string;
  onArchived: () => void;
  onPublished: () => void;
}>(({ connectorId, onArchived, onPublished }) => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const { canArchive, canPublish, canTest, canUpdate } =
    deriveAdminConnectorPermissions(permissions);
  const { data, error, isLoading, mutate } = useFetchAdminConnector(connectorId, true);
  const [busy, setBusy] = useState(false);

  const canApply = canPublish && canUpdate;
  const draft = data?.draft;
  const published = data?.published;
  const isLive = draft?.status === 'published' || Boolean(published);

  const onPublish = useCallback(async () => {
    if (!data) return;
    setBusy(true);
    try {
      const result = await adminConnectorsService.applyImmediate({
        expectedDraftToken: data.draftToken,
        expectedRevision: data.baseRevision,
        id: data.draft.id,
        mode: 'update',
        reason: 'Publish platform connector from admin settings',
      });
      if (result.published) {
        toast.success(
          t('aiConnectorSettings.actions.published', {
            defaultValue: 'Connector listed for all users',
          }),
        );
      } else {
        toast.success(
          t('aiConnectorSettings.actions.draftSaved', {
            defaultValue: 'Connector saved as draft — complete config to list it',
          }),
        );
      }
      await Promise.all([mutate(), refreshAdminConnectorLists()]);
      onPublished();
    } catch {
      // toast already shown by service wrapper
    } finally {
      setBusy(false);
    }
  }, [data, mutate, onPublished, t]);

  const onTest = useCallback(async () => {
    if (!data) return;
    setBusy(true);
    try {
      const result = await adminConnectorsService.test({
        id: data.draft.id,
        reason: 'Test connector from admin settings',
      });
      if (result.status === 'success') {
        toast.success(t('aiConnectorSettings.actions.testOk', { defaultValue: 'Connection OK' }));
      } else {
        toast.error(
          result.messageCode ||
            t('aiConnectorSettings.actions.testFail', { defaultValue: 'Connection test failed' }),
        );
      }
      await mutate();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Test failed');
    } finally {
      setBusy(false);
    }
  }, [data, mutate, t]);

  const onArchive = useCallback(() => {
    if (!data) return;
    confirmModal({
      cancelText: t('users.modals.cancel'),
      content: t('aiConnectorSettings.actions.archiveConfirmDesc', {
        defaultValue: 'Archive removes this connector from the live catalog for all users.',
        name: data.draft.displayName,
      }),
      okButtonProps: { danger: true },
      okText: t('aiConnectorSettings.actions.archive', { defaultValue: 'Unlist' }),
      title: t('aiConnectorSettings.actions.archiveConfirmTitle', {
        defaultValue: 'Unlist connector?',
      }),
      onOk: async () => {
        setBusy(true);
        try {
          await adminConnectorsService.archiveImmediate({
            expectedDraftToken: data.draftToken,
            expectedRevision: data.baseRevision,
            id: data.draft.id,
            reason: 'Archive platform connector from admin settings',
          });
          toast.success(
            t('aiConnectorSettings.actions.archived', { defaultValue: 'Connector unlisted' }),
          );
          await Promise.all([mutate(), refreshAdminConnectorLists()]);
          onArchived();
        } catch {
          // toast already shown by service wrapper
        } finally {
          setBusy(false);
        }
      },
    });
  }, [data, mutate, onArchived, t]);

  if (error && !data) {
    return <AsyncError error={error} variant="page" onRetry={() => void mutate()} />;
  }
  if (isLoading && !data) {
    return <Loading debugId="Admin > Connectors > Detail" />;
  }
  if (!draft) {
    return (
      <div className={styles.detailBody}>
        {t('aiConnectorSettings.detail.notFound', { defaultValue: 'Connector not found' })}
      </div>
    );
  }

  return (
    <>
      <header className={styles.detailHeader}>
        <Flexbox horizontal align="center" gap={8} justify="space-between">
          <Text strong as="h2">
            {draft.displayName}
          </Text>
          <Flexbox horizontal gap={8}>
            <Tag color={isLive ? 'success' : draft.status === 'archived' ? 'default' : 'warning'}>
              {draft.status}
            </Tag>
            <Tag>{draft.credentialMode}</Tag>
          </Flexbox>
        </Flexbox>
        <Text type="secondary">
          {draft.description ||
            t('aiConnectorSettings.detail.noDescription', { defaultValue: 'No description' })}
        </Text>
      </header>
      <main className={styles.detailBody}>
        <section className={styles.card}>
          <Text type="secondary">{t('connectorCatalog.create.key')}</Text>
          <Text code>{draft.key}</Text>
          <Text type="secondary">{t('connectorCatalog.editor.endpoint')}</Text>
          <Text ellipsis>{draft.endpoint}</Text>
          <Text type="secondary">
            {t('aiConnectorSettings.detail.transport', { defaultValue: 'Transport' })}
          </Text>
          <Text>{draft.transport}</Text>
          <Text type="secondary">{t('connectorCatalog.editor.enabled')}</Text>
          <Text>{draft.enabled ? 'Yes' : 'No'}</Text>
          {published ? (
            <>
              <Text type="secondary">
                {t('aiConnectorSettings.detail.publishedRevision', {
                  defaultValue: 'Published revision',
                })}
              </Text>
              <Text>{published.publishedRevision}</Text>
            </>
          ) : null}
        </section>

        <Flexbox gap={8}>
          <Text strong>
            {t('aiConnectorSettings.detail.tools', { defaultValue: 'Tools' })} ({draft.tools.length}
            )
          </Text>
          <Flexbox className={styles.tools} gap={8} role="list">
            {draft.tools.map((tool) => (
              <Flexbox
                horizontal
                gap={8}
                justify="space-between"
                key={tool.toolKey}
                role="listitem"
              >
                <Text ellipsis>{tool.displayName}</Text>
                <Tag color={tool.enabled ? 'success' : 'default'}>
                  {tool.enabled ? 'enabled' : 'disabled'}
                </Tag>
              </Flexbox>
            ))}
          </Flexbox>
        </Flexbox>

        <Flexbox horizontal gap={8}>
          {canApply ? (
            <Button disabled={busy} loading={busy} type="primary" onClick={onPublish}>
              {isLive
                ? t('aiConnectorSettings.actions.republish', { defaultValue: 'Apply changes' })
                : t('aiConnectorSettings.actions.publish', { defaultValue: 'List (publish)' })}
            </Button>
          ) : null}
          {canTest ? (
            <Button disabled={busy} onClick={onTest}>
              {t('aiConnectorSettings.actions.test', { defaultValue: 'Test connection' })}
            </Button>
          ) : null}
          {canArchive && draft.status !== 'archived' ? (
            <Button danger disabled={busy} onClick={onArchive}>
              {t('aiConnectorSettings.actions.archive', { defaultValue: 'Unlist' })}
            </Button>
          ) : null}
          <Link className={styles.advancedLink} to={`/admin/connectors/${draft.id}`}>
            {t('aiConnectorSettings.actions.editAdvanced', {
              defaultValue: 'Edit in advanced catalog',
            })}
          </Link>
        </Flexbox>
      </main>
    </>
  );
});

/**
 * Admin parity page for `/admin/ai/connectors` (+ `/:id`).
 * Master-detail visual language aligned with user Connectors settings;
 * data from admin.connectors; no per-user OAuth connect/disconnect.
 */
const ConnectorSettingsPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const { authMethod, permissions } = useAdminAccess();
  const { canCreate, canPublish, canRead } = deriveAdminConnectorPermissions(permissions);
  const [query, setQuery] = useState('');
  const listInput = useMemo(
    () => ({
      limit: 100,
      query: query.trim() || undefined,
    }),
    [query],
  );
  const { data, error, isLoading, mutate } = useFetchAdminConnectors(listInput, canRead);
  const selectedId = params.id;
  const items = data?.items ?? [];

  const onSelect = (id: string) => {
    navigate(`/admin/ai/connectors/${encodeURIComponent(id)}`);
  };

  const onCreate = () => {
    openCreateConnectorModal({
      authMethod,
      onSubmit: async (input) => {
        const result = await adminConnectorsService.applyImmediate({
          ...input,
          mode: 'create',
        });
        await refreshAdminConnectorLists();
        await mutate();
        if (result.published) {
          toast.success(
            t('aiConnectorSettings.actions.published', {
              defaultValue: 'Connector listed for all users',
            }),
          );
        } else {
          toast.success(
            t('aiConnectorSettings.actions.draftSaved', {
              defaultValue: 'Connector saved as draft — complete config to list it',
            }),
          );
        }
        navigate(`/admin/ai/connectors/${encodeURIComponent(result.draft.id)}`);
      },
    });
  };

  return (
    <div className={styles.shell}>
      <div className={styles.toolbar}>
        <div>
          <Text as="h1" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
            {t('nav.aiConnectors', { defaultValue: 'Connectors' })}
          </Text>
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('aiConnectorSettings.description', {
              defaultValue:
                'Manage the global platform connector catalog. Listing publishes for all users. Per-user OAuth is not managed here.',
            })}
          </Text>
        </div>
        <Link className={styles.advancedLink} to="/admin/connectors">
          {t('aiConnectorSettings.advancedCatalog', {
            defaultValue: 'Advanced catalog management',
          })}
        </Link>
      </div>
      <div className={styles.body}>
        <div className={styles.left}>
          <div className={styles.leftHeader}>
            <Text strong style={{ fontSize: 14 }}>
              {t('nav.aiConnectors', { defaultValue: 'Connectors' })}
            </Text>
            {canCreate && canPublish ? (
              <Button size="small" type="primary" onClick={onCreate}>
                {t('aiConnectorSettings.actions.create', { defaultValue: 'List connector' })}
              </Button>
            ) : null}
          </div>
          <div style={{ padding: '8px 12px' }}>
            <SearchBar
              allowClear
              placeholder={t('primitives.filterBar.searchPlaceholder')}
              value={query}
              onInputChange={setQuery}
              onSearch={setQuery}
            />
          </div>
          <div className={styles.leftBody}>
            {error && !data ? (
              <AsyncError error={error} variant="block" onRetry={() => void mutate()} />
            ) : isLoading && !data ? (
              <Loading debugId="Admin > Connectors > List" />
            ) : items.length === 0 ? (
              <Center paddingBlock={32}>
                <Empty
                  icon={Plug}
                  title={t('aiConnectorSettings.empty.title', { defaultValue: 'No connectors' })}
                  description={t('aiConnectorSettings.empty.desc', {
                    defaultValue:
                      'No platform connectors yet. List one to make it available to users.',
                  })}
                />
              </Center>
            ) : (
              <Flexbox gap={4}>
                {items.map((connector) => (
                  <ConnectorListItem
                    connector={connector}
                    isSelected={selectedId === connector.id}
                    key={connector.id}
                    onSelect={() => onSelect(connector.id)}
                  />
                ))}
              </Flexbox>
            )}
          </div>
        </div>
        <div className={styles.content}>
          <div style={{ padding: '12px 24px 0' }}>
            <DraftPublishBanner
              activeConnectorId={selectedId}
              onPublished={() => {
                void mutate();
                void refreshAdminConnectorLists();
              }}
            />
          </div>
          {selectedId ? (
            <ConnectorDetailPanel
              connectorId={selectedId}
              onArchived={() => {
                void mutate();
                navigate('/admin/ai/connectors');
              }}
              onPublished={() => {
                void mutate();
              }}
            />
          ) : (
            <Center paddingBlock={64}>
              <Empty
                icon={Plug}
                description={t('aiConnectorSettings.select.desc', {
                  defaultValue: 'Select a connector from the list, or list a new one.',
                })}
                title={t('aiConnectorSettings.select.title', {
                  defaultValue: 'Select a connector',
                })}
              />
            </Center>
          )}
        </div>
      </div>
    </div>
  );
});

ConnectorSettingsPage.displayName = 'AdminConnectorSettingsPage';

export default ConnectorSettingsPage;
