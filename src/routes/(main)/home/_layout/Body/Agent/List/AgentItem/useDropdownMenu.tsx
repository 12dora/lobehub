import { BUILTIN_AGENT_SLUGS } from '@lobechat/builtin-agents';
import { SessionDefaultGroup, type SidebarVisibility } from '@lobechat/types';
import { type MenuProps } from '@lobehub/ui';
import { Icon } from '@lobehub/ui';
import { confirmModal } from '@lobehub/ui/base-ui';
import { App } from 'antd';
import isEqual from 'fast-deep-equal';
import {
  Check,
  EyeOffIcon,
  FolderInputIcon,
  GlobeIcon,
  LucideCopy,
  LucidePlus,
  Pen,
  PictureInPicture2Icon,
  Pin,
  PinOff,
  Trash,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import { useAgentTransferMenuItem } from '@/business/client/hooks/useAgentTransferMenuItem';
import { useIsWorkspaceOwner } from '@/business/client/hooks/useIsWorkspaceOwner';
import { openEditingPopover } from '@/features/EditingPopover/store';
import { useManagedResource } from '@/features/ManagedResources';
import VisibilityConfirmContent from '@/features/VisibilityConfirmContent';
import { usePermission } from '@/hooks/usePermission';
import { agentService } from '@/services/agent';
import { useGlobalStore } from '@/store/global';
import { useHomeStore } from '@/store/home';
import { homeAgentListSelectors } from '@/store/home/selectors';
import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

const BUILTIN_SLUGS = new Set<string>(Object.values(BUILTIN_AGENT_SLUGS));

interface UseAgentDropdownMenuParams {
  anchor: HTMLElement | null;
  avatar?: string;
  backgroundColor?: string;
  group: string | undefined;
  id: string;
  /**
   * Platform-managed (org-distributed) agent. The server rejects every mutation on it, so the
   * menu omits every mutating entry (pin/rename/duplicate/move/publish/makePrivate/delete) and
   * keeps only the pure-read "open in new window".
   */
  managed?: boolean;
  openCreateGroupModal: () => void;
  pinned: boolean;
  slug?: string | null;
  title: string;
  userId?: string | null;
  visibility?: SidebarVisibility;
}

export const useAgentDropdownMenu = ({
  anchor,
  avatar,
  backgroundColor,
  group,
  id,
  managed,
  openCreateGroupModal,
  pinned,
  slug,
  title,
  userId,
  visibility,
}: UseAgentDropdownMenuParams): (() => MenuProps['items']) => {
  const { t } = useTranslation(['chat', 'common']);
  const { message } = App.useApp();

  const openAgentInNewWindow = useGlobalStore((s) => s.openAgentInNewWindow);
  // Pick the group bucket that matches this agent's visibility so the
  // "Move to group" picker only offers same-scope targets — moving a private
  // agent into a public group (or vice versa) would orphan it from the view
  // it currently lives in.
  const sessionCustomGroups = useHomeStore(
    visibility === 'private'
      ? homeAgentListSelectors.privateAgentGroups
      : homeAgentListSelectors.agentGroups,
    isEqual,
  );
  const refreshAgentList = useHomeStore((s) => s.refreshAgentList);
  const [pinAgent, duplicateAgent, updateAgentGroup, removeAgent] = useHomeStore((s) => [
    s.pinAgent,
    s.duplicateAgent,
    s.updateAgentGroup,
    s.removeAgent,
  ]);

  // Visibility actions are only meaningful inside a workspace: in personal
  // mode every row is implicitly owner-private. "Publish to Workspace"
  // appears on private agents; the inverse "Make private" (LOBE-11551)
  // appears on published agents, but only for the creator or a workspace
  // owner, and never on builtin agents (LobeAI etc.). The server enforces
  // the same rules as a backstop.
  const activeWorkspaceId = useActiveWorkspaceId();
  const isWorkspaceOwner = useIsWorkspaceOwner();
  const currentUserId = useUserStore(userProfileSelectors.userId);
  const isPrivate = visibility === 'private';
  const isBuiltin = !!slug && BUILTIN_SLUGS.has(slug);
  const showPublishAction = Boolean(activeWorkspaceId) && isPrivate;
  const showMakePrivateAction =
    Boolean(activeWorkspaceId) &&
    visibility === 'public' &&
    !isBuiltin &&
    (isWorkspaceOwner || (!!currentUserId && userId === currentUserId));

  // Viewer has no write permissions on agents — disable every mutating menu
  // item (pin/rename/duplicate/move/delete) while keeping the menu visible
  // so they can still inspect what actions exist. `openInNewWindow` is a
  // pure read so it stays enabled.
  const { allowed: canEdit } = usePermission('edit_own_content');
  const { allowed: canCreate } = usePermission('create_content');

  // Org-hosted agent catalog: the managed-resource mutation registry marks every entry that
  // rewrites an agent definition as `deny` — rename (`agent.updateAgentConfig`),
  // `agent.duplicateAgent`, move-to-group (`home.updateAgentSessionGroupId`),
  // `agent.transferAgent`, `agent.publishAgentToWorkspace`, `agent.setAgentVisibility` and
  // `agent.removeAgent`. Only `agent.updateAgentPinned` stays `exempt` (a per-user presentation
  // preference) and "open in new window" is a pure read, so those two survive. Fails closed while
  // the capability payload is loading or errored, like `CreateAgentButton`.
  const { blocked: agentMutationBlocked } = useManagedResource('agents');

  // Cross-workspace Transfer to… / Copy to… items (null when workspace feature is off)
  const transferMenuItems = useAgentTransferMenuItem(id, {
    avatar,
    backgroundColor,
    title,
  });

  const isDefault = group === SessionDefaultGroup.Default;

  return useMemo(
    () => () => {
      const openInNewWindowItem = {
        icon: <Icon icon={PictureInPicture2Icon} />,
        key: 'openInNewWindow',
        label: t('openInNewWindow'),
        onClick: ({ domEvent }: any) => {
          domEvent.stopPropagation();
          openAgentInNewWindow(id);
        },
      };

      // Platform-managed (org-distributed) agents are read-only for the user: the server rejects
      // every mutation (delete/rename/pin/move/visibility) — deleting one even hits a synthetic
      // `platform-agent:<uuid>` id that matches no local row. Omit every mutating entry rather than
      // render dead, always-failing (and previously false-success) affordances. Only the pure-read
      // "open in new window" stays.
      if (managed) return [openInNewWindowItem] as MenuProps['items'];

      // Same reasoning one level up: while the platform hosts the agent catalog, a *local* row
      // can still be listed (until the server-side list replace lands) but every definition edit
      // is refused. Keep only pin (exempt) + the read-only "open in new window".
      if (agentMutationBlocked)
        return [
          {
            disabled: !canEdit,
            icon: <Icon icon={pinned ? PinOff : Pin} />,
            key: 'pin',
            label: t(pinned ? 'pinOff' : 'pin'),
            onClick: () => pinAgent(id, !pinned),
          },
          openInNewWindowItem,
        ] as MenuProps['items'];

      return [
        {
          disabled: !canEdit,
          icon: <Icon icon={pinned ? PinOff : Pin} />,
          key: 'pin',
          label: t(pinned ? 'pinOff' : 'pin'),
          onClick: () => pinAgent(id, !pinned),
        },
        {
          disabled: !canEdit,
          icon: <Icon icon={Pen} />,
          key: 'rename',
          label: t('rename', { ns: 'common' }),
          onClick: (info: any) => {
            info.domEvent?.stopPropagation();
            if (anchor) {
              openEditingPopover({ anchor, avatar, id, title, type: 'agent' });
            }
          },
        },
        {
          disabled: !canCreate,
          icon: <Icon icon={LucideCopy} />,
          key: 'duplicate',
          label: t('duplicate', { ns: 'common' }),
          onClick: ({ domEvent }: any) => {
            domEvent.stopPropagation();
            duplicateAgent(id);
          },
        },
        openInNewWindowItem,
        { type: 'divider' },
        {
          disabled: !canEdit,
          children: [
            ...sessionCustomGroups.map(({ id: groupId, name }) => ({
              icon: group === groupId ? <Icon icon={Check} /> : <div />,
              key: groupId,
              label: name,
              onClick: () => updateAgentGroup(id, groupId),
            })),
            {
              icon: isDefault ? <Icon icon={Check} /> : <div />,
              key: 'defaultList',
              label: t('defaultList'),
              onClick: () => updateAgentGroup(id, SessionDefaultGroup.Default),
            },
            { type: 'divider' as const },
            {
              icon: <Icon icon={LucidePlus} />,
              key: 'createGroup',
              label: <div>{t('sessionGroup.createGroup')}</div>,
              onClick: ({ domEvent }: any) => {
                domEvent.stopPropagation();
                openCreateGroupModal();
              },
            },
          ],
          icon: <Icon icon={FolderInputIcon} />,
          key: 'moveGroup',
          label: t('sessionGroup.moveGroup'),
        },
        { type: 'divider' },
        ...(transferMenuItems ?? []),
        ...(transferMenuItems?.length ? [{ type: 'divider' as const }] : []),
        ...(showPublishAction
          ? [
              {
                disabled: !canEdit,
                icon: <Icon icon={GlobeIcon} />,
                key: 'publishToWorkspace',
                label: t('agent.publishToWorkspace', { defaultValue: 'Publish to Workspace' }),
                onClick: async ({ domEvent }: any) => {
                  domEvent?.stopPropagation();
                  if (!canEdit) return;
                  confirmModal({
                    cancelText: t('cancel', { ns: 'common' }),
                    content: <VisibilityConfirmContent variant="publish" />,
                    okText: t('agent.publishToWorkspace', {
                      defaultValue: 'Publish to Workspace',
                    }),
                    onOk: async () => {
                      try {
                        await agentService.publishAgentToWorkspace(id);
                        await refreshAgentList();
                        message.success(
                          t('agent.publishToWorkspaceSuccess', {
                            defaultValue: 'Published to workspace',
                          }),
                        );
                      } catch (error) {
                        console.error('Failed to publish agent:', error);
                        message.error(
                          t('error', { ns: 'common', defaultValue: 'Operation failed' }),
                        );
                      }
                    },
                    title: t('agent.publishToWorkspace', {
                      defaultValue: 'Publish to Workspace',
                    }),
                  });
                },
              },
              { type: 'divider' as const },
            ]
          : []),
        ...(showMakePrivateAction
          ? [
              {
                disabled: !canEdit,
                icon: <Icon icon={EyeOffIcon} />,
                key: 'makePrivate',
                label: t('makePrivate', { ns: 'common' }),
                onClick: async ({ domEvent }: any) => {
                  domEvent?.stopPropagation();
                  if (!canEdit) return;
                  confirmModal({
                    cancelText: t('cancel', { ns: 'common' }),
                    content: <VisibilityConfirmContent variant="makePrivate" />,
                    okButtonProps: { danger: true },
                    okText: t('makePrivate.confirm.ok', { ns: 'common' }),
                    onOk: async () => {
                      try {
                        await agentService.setAgentVisibility(id, 'private');
                        await refreshAgentList();
                        message.success(t('makePrivate.success', { ns: 'common' }));
                      } catch (error) {
                        console.error('Failed to make agent private:', error);
                        message.error(t('makePrivate.error', { ns: 'common' }));
                      }
                    },
                    title: t('makePrivate.confirm.title', { ns: 'common' }),
                  });
                },
              },
              { type: 'divider' as const },
            ]
          : []),
        {
          danger: true,
          disabled: !canEdit,
          icon: <Icon icon={Trash} />,
          key: 'delete',
          label: t('delete', { ns: 'common' }),
          onClick: ({ domEvent }: any) => {
            domEvent.stopPropagation();
            confirmModal({
              cancelText: t('cancel', { ns: 'common' }),
              content: t('confirmRemoveSessionItemAlert'),
              okButtonProps: { danger: true },
              okText: t('delete', { ns: 'common' }),
              onOk: async () => {
                await removeAgent(id);
                message.success(t('confirmRemoveSessionSuccess'));
              },
              title: t('delete', { ns: 'common' }),
            });
          },
        },
      ] as MenuProps['items'];
    },
    [
      agentMutationBlocked,
      anchor,
      canCreate,
      canEdit,
      managed,
      openAgentInNewWindow,
      pinned,
      id,
      avatar,
      backgroundColor,
      title,
      sessionCustomGroups,
      group,
      isDefault,
      openCreateGroupModal,
      message,
      transferMenuItems,
      showPublishAction,
      showMakePrivateAction,
      refreshAgentList,
      t,
    ],
  );
};
