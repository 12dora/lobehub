'use client';

import { getComposioAppByIdentifier, getLobehubSkillProviderById } from '@lobechat/const';
import { Avatar, Markdown, Skeleton } from '@lobehub/ui';
import { Button, confirmModal } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import isEqual from 'fast-deep-equal';
import { Plus, SquareArrowOutUpRight, Trash2, Unplug } from 'lucide-react';
import { lazy, memo, Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAdminToolScope } from '@/features/AdminToolScope';
import AdminBuiltinSkillDistribution from '@/features/AdminToolScope/AdminBuiltinSkillDistribution';
import { ConnectorDetail } from '@/features/Connectors';
import { useSkillConnect } from '@/features/SkillStore/SkillList/LobeHub/useSkillConnect';
import { usePermission } from '@/hooks/usePermission';
import { useToolStore } from '@/store/tool';
import {
  builtinToolSelectors,
  composioStoreSelectors,
  lobehubSkillStoreSelectors,
} from '@/store/tool/selectors';
import { ComposioServerStatus } from '@/store/tool/slices/composioStore';
import { connectorSelectors } from '@/store/tool/slices/connector';

import { getLocalizedBuiltinSkillDetail, getNoPermissionsTitle } from './localization';
import {
  ManagedComposioDisconnectButton,
  shouldSyncConnectorDefinition,
} from './managedConnectorBehavior';
import PlatformSkillDetail from './PlatformSkillDetail';

const AgentSkillDetail = lazy(() => import('@/features/AgentSkillDetail'));

export type ToolDetailType =
  | 'agent-skill'
  | 'builtin'
  | 'builtin-skill'
  | 'lobehub-connector'
  | 'mcp-connector'
  | 'platform-skill'
  | 'plugin';

const styles = createStaticStyles(({ css, cssVar }) => ({
  description: css`
    margin-block-start: 8px;
    font-size: 13px;
    line-height: 1.6;
    color: ${cssVar.colorTextSecondary};
  `,
  header: css`
    display: flex;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;

    padding-block: 20px 16px;
    padding-inline: 24px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  name: css`
    font-size: 16px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  noPermissions: css`
    padding: 24px;
    font-size: 14px;
    color: ${cssVar.colorTextTertiary};
  `,
  noPermissionsHeader: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    margin-block-end: 8px;
  `,
  noPermissionsTitle: css`
    font-size: 16px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
}));

interface SkillDetailProps {
  identifier: string;
  managed?: boolean;
  onDelete?: () => void;
  type: ToolDetailType;
}

interface LobehubConnectorActionProps {
  identifier: string;
  label: string;
  onDisconnected?: () => void;
}

const LobehubConnectorAction = memo<LobehubConnectorActionProps>(
  ({ identifier, label, onDisconnected }) => {
    const { t } = useTranslation('setting');
    const { allowed: canCreate } = usePermission('create_content');
    const { allowed: canEdit } = usePermission('edit_own_content');
    const { handleConnect, handleDisconnect, isConnected, isConnecting } = useSkillConnect({
      identifier,
      type: 'lobehub',
    });

    const handleConfirmDisconnect = useCallback(() => {
      if (!canEdit) return;

      confirmModal({
        cancelText: t('cancel', { ns: 'common' }),
        content: t('tools.lobehubSkill.disconnectConfirm.desc', { name: label }),
        okButtonProps: { danger: true },
        okText: t('tools.lobehubSkill.disconnect'),
        onOk: async () => {
          const disconnected = await handleDisconnect();
          if (disconnected) onDisconnected?.();
        },
        title: t('tools.lobehubSkill.disconnectConfirm.title', { name: label }),
      });
    }, [canEdit, handleDisconnect, label, onDisconnected, t]);

    if (isConnected) {
      return (
        <Button
          danger
          disabled={!canEdit}
          icon={<Unplug size={14} />}
          loading={isConnecting}
          size="small"
          onClick={handleConfirmDisconnect}
        >
          {t('tools.lobehubSkill.disconnect')}
        </Button>
      );
    }

    return (
      <Button
        disabled={!canCreate || !canEdit}
        icon={<SquareArrowOutUpRight size={14} />}
        loading={isConnecting}
        size="small"
        onClick={() => {
          if (!canCreate || !canEdit) return;
          handleConnect();
        }}
      >
        {t('tools.lobehubSkill.connect')}
      </Button>
    );
  },
);

LobehubConnectorAction.displayName = 'LobehubConnectorAction';

interface ComposioConnectorActionProps {
  identifier: string;
  label: string;
  onDisconnected?: () => void;
}

const ComposioConnectorAction = memo<ComposioConnectorActionProps>(
  ({ identifier, label, onDisconnected }) => {
    const { allowed: canEdit } = usePermission('edit_own_content');
    const server = useToolStore(composioStoreSelectors.getServerByIdentifier(identifier));
    const removeComposioConnection = useToolStore((s) => s.removeComposioConnection);

    if (!server || server.status !== ComposioServerStatus.ACTIVE) return null;

    return (
      <ManagedComposioDisconnectButton
        canEdit={canEdit}
        identifier={identifier}
        label={label}
        onDisconnect={removeComposioConnection}
        onDisconnected={onDisconnected}
      />
    );
  },
);

ComposioConnectorAction.displayName = 'ComposioConnectorAction';

/**
 * Right panel for the Settings > Skill master-detail layout.
 *
 * - 'agent-skill': renders AgentSkillDetail inline (user/market agent skills with UUID id)
 * - 'builtin-skill': renders BuiltinSkill description panel (Artifacts, Task, etc.)
 * - 'builtin'/'plugin'/'mcp-connector': syncs connector entry, renders permission editor
 */
const LegacySkillDetail = memo<SkillDetailProps>(
  ({ identifier, managed = false, type, onDelete }) => {
    const { t } = useTranslation('plugin');
    const { t: ts } = useTranslation('setting');
    const [syncing, setSyncing] = useState(false);
    const [noManifest, setNoManifest] = useState(false);
    const adminScope = useAdminToolScope();

    const { allowed: canCreate } = usePermission('create_content');
    const { allowed: canEdit } = usePermission('edit_own_content');

    const syncBuiltinTool = useToolStore((s) => s.syncBuiltinTool);
    const syncPluginTools = useToolStore((s) => s.syncPluginTools);
    const syncToolsFromClient = useToolStore((s) => s.syncToolsFromClient);
    const fetchConnectors = useToolStore((s) => s.fetchConnectors);
    const installBuiltinTool = useToolStore((s) => s.installBuiltinTool);
    const uninstallBuiltinTool = useToolStore((s) => s.uninstallBuiltinTool);
    const deleteAgentSkill = useToolStore((s) => s.deleteAgentSkill);
    const storeConnector = useToolStore(connectorSelectors.connectorByIdentifier(identifier));
    const connector = adminScope
      ? adminScope.connectors.find((c) => c.identifier === identifier)
      : storeConnector;

    // For lobehub-connector: get the server's tool list from the store
    const lobehubServer = useToolStore(
      lobehubSkillStoreSelectors.getServerByIdentifier(identifier),
    );
    const lobehubProvider =
      type === 'lobehub-connector' ? getLobehubSkillProviderById(identifier) : undefined;
    const lobehubLabel =
      type === 'lobehub-connector'
        ? lobehubProvider?.label || lobehubServer?.name || identifier
        : identifier;
    const composioApp = type === 'plugin' ? getComposioAppByIdentifier(identifier) : undefined;

    // For builtin-skill: look up from store
    const builtinSkill = useToolStore(
      (s) => s.builtinSkills?.find((sk) => sk.identifier === identifier),
      isEqual,
    );
    const storeBuiltinInstalled = useToolStore(
      builtinToolSelectors.isBuiltinToolInstalled(identifier),
    );
    const isBuiltinInstalled = adminScope
      ? adminScope.isBuiltinSkillEnabled(identifier)
      : storeBuiltinInstalled;

    const isConnectorType =
      type === 'builtin' ||
      type === 'plugin' ||
      type === 'mcp-connector' ||
      type === 'lobehub-connector';

    const { title: builtinSkillTitle, description: builtinSkillDescription } =
      getLocalizedBuiltinSkillDetail(builtinSkill, identifier, ts);
    const noPermissionsTitle = getNoPermissionsTitle(identifier, type, ts);

    const renderConnectorLifecycleAction = (onDisconnected?: () => void) => {
      // Per-user OAuth lifecycle (connect/disconnect) has no org-wide meaning;
      // the admin surface shows the catalog entry without personal actions.
      if (adminScope && (type === 'lobehub-connector' || composioApp)) return null;
      if (type === 'lobehub-connector') {
        return (
          <LobehubConnectorAction
            identifier={identifier}
            label={lobehubLabel}
            onDisconnected={onDisconnected}
          />
        );
      }
      if (composioApp) {
        return (
          <ComposioConnectorAction
            identifier={identifier}
            label={composioApp.label}
            onDisconnected={onDisconnected}
          />
        );
      }
      return undefined;
    };

    useEffect(() => {
      // Admin scope: connector rows are synthesized from the org catalog and
      // builtin manifests — never sync per-user connector rows from here.
      if (adminScope || !shouldSyncConnectorDefinition({ isConnectorType, managed })) {
        setNoManifest(false);
        setSyncing(false);
        return;
      }

      setNoManifest(false);
      const ensureConnector = async () => {
        setSyncing(true);
        try {
          if (type === 'builtin') {
            await syncBuiltinTool(identifier);
          } else if (type === 'lobehub-connector') {
            // Use tools from the lobehub skill server (already fetched via OAuth flow)
            const tools = (lobehubServer?.tools ?? []).map((t) => ({
              description: t.description,
              inputSchema: t.inputSchema as Record<string, unknown>,
              toolName: t.name,
            }));
            if (tools.length === 0) {
              setNoManifest(true);
            } else {
              await syncToolsFromClient({
                identifier,
                name: lobehubServer?.name || identifier,
                sourceType: 'marketplace',
                tools,
              });
            }
          } else if (type === 'plugin') {
            await syncPluginTools(identifier);
          } else {
            await fetchConnectors();
          }
        } catch {
          setNoManifest(true);
        } finally {
          setSyncing(false);
        }
      };

      ensureConnector();
    }, [
      adminScope,
      fetchConnectors,
      identifier,
      isConnectorType,
      managed,
      lobehubServer?.name,
      lobehubServer?.tools,
      syncBuiltinTool,
      syncPluginTools,
      syncToolsFromClient,
      type,
    ]);

    const handleUninstallBuiltin = () => {
      confirmModal({
        okButtonProps: { danger: true },
        onOk: async () => {
          if (adminScope) {
            await adminScope.toggleBuiltinSkill(identifier, false);
            return;
          }
          await uninstallBuiltinTool(identifier);
        },
        title: t('store.actions.confirmUninstall'),
      });
    };

    const handleDeleteAgentSkill = () => {
      confirmModal({
        okButtonProps: { danger: true },
        onOk: async () => {
          if (adminScope) {
            await adminScope.deleteOrgSkill(identifier);
          } else {
            await deleteAgentSkill(identifier);
          }
          onDelete?.();
        },
        title: t('store.actions.confirmUninstall'),
      });
    };

    // ── Render by type ──────────────────────────────────────────────────────────

    if (type === 'agent-skill') {
      return (
        <div
          style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
        >
          <div
            style={{
              alignItems: 'center',
              borderBlockEnd: '1px solid var(--ant-color-border-secondary)',
              display: 'flex',
              flexShrink: 0,
              justifyContent: 'flex-end',
              padding: '8px 16px',
            }}
          >
            <Button
              danger
              disabled={!canEdit}
              icon={<Trash2 size={14} />}
              size="small"
              onClick={handleDeleteAgentSkill}
            >
              {t('store.actions.uninstall')}
            </Button>
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <Suspense
              fallback={
                <div style={{ padding: 24 }}>
                  <Skeleton active paragraph={{ rows: 6 }} title={false} />
                </div>
              }
            >
              <AgentSkillDetail
                skillId={identifier}
                useFetchDetail={adminScope?.useOrgSkillDetail}
              />
            </Suspense>
          </div>
        </div>
      );
    }

    if (type === 'builtin-skill') {
      return (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <div className={styles.header}>
            <div style={{ alignItems: 'flex-start', display: 'flex', gap: 12 }}>
              {builtinSkill?.avatar && <Avatar avatar={builtinSkill.avatar} size={40} />}
              <div>
                <div className={styles.name}>{builtinSkillTitle}</div>
                {builtinSkillDescription && (
                  <div className={styles.description}>{builtinSkillDescription}</div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexShrink: 0, gap: 8 }}>
              {isBuiltinInstalled ? (
                <Button danger disabled={!canEdit} size="small" onClick={handleUninstallBuiltin}>
                  {t('store.actions.uninstall')}
                </Button>
              ) : (
                <Button
                  disabled={!canCreate}
                  icon={<Plus size={14} />}
                  size="small"
                  onClick={() => {
                    if (adminScope) {
                      void adminScope.toggleBuiltinSkill(identifier, true);
                      return;
                    }
                    void installBuiltinTool(identifier);
                  }}
                >
                  {t('store.actions.install')}
                </Button>
              )}
            </div>
          </div>
          {adminScope ? (
            <AdminBuiltinSkillDistribution identifier={identifier} scope={adminScope} />
          ) : null}
          {builtinSkill?.content && (
            <div style={{ padding: '16px 24px' }}>
              <Markdown variant="chat">{builtinSkill.content}</Markdown>
            </div>
          )}
        </div>
      );
    }

    // Connector types: builtin tool / plugin / mcp-connector
    if (syncing) {
      return (
        <div style={{ padding: 24 }}>
          <Skeleton active paragraph={{ rows: 6 }} title={false} />
        </div>
      );
    }

    if (noManifest || !connector) {
      return (
        <div className={styles.noPermissions}>
          <div className={styles.noPermissionsHeader}>
            <div className={styles.noPermissionsTitle}>
              {type === 'lobehub-connector' ? lobehubLabel : noPermissionsTitle}
            </div>
            {renderConnectorLifecycleAction()}
          </div>
          {ts('tools.noConfigurablePermissions')}
        </div>
      );
    }

    return (
      <ConnectorDetail
        connectorId={connector.id}
        lifecycleActions={renderConnectorLifecycleAction(() => setNoManifest(true))}
        managed={managed}
        onDelete={onDelete}
      />
    );
  },
);

LegacySkillDetail.displayName = 'LegacySkillDetail';

const SkillDetail = memo<SkillDetailProps>((props) =>
  props.type === 'platform-skill' ? (
    <PlatformSkillDetail skillKey={props.identifier} />
  ) : props.managed ? null : (
    <LegacySkillDetail {...props} />
  ),
);

SkillDetail.displayName = 'SkillDetail';

export default SkillDetail;
