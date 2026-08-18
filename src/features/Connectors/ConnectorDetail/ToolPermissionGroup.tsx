import { Button, DropdownMenu } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { ChevronDownIcon, ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConnectorToolPermission } from '@/database/schemas';
import type { ConnectorTool } from '@/store/tool/slices/connector';

import ToolPermissionRow from './ToolPermissionRow';

const styles = createStaticStyles(({ css, cssVar }) => ({
  badge: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;

    padding-block: 1px;
    padding-inline: 6px;
    border-radius: 4px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillSecondary};
  `,
  groupHeader: css`
    cursor: pointer;
    user-select: none;

    display: flex;
    gap: 8px;
    align-items: center;

    padding-block: 10px;
    padding-inline: 0;

    &:hover span {
      color: ${cssVar.colorText};
    }
  `,
  groupLabel: css`
    display: flex;
    flex: 1;
    gap: 6px;
    align-items: center;

    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
}));

interface ToolPermissionGroupProps {
  label: string;
  onBatchPermission: (
    toolIds: string[],
    permission: ConnectorToolPermission,
  ) => void | Promise<void>;
  onPermissionChange: (toolId: string, permission: ConnectorToolPermission) => void;
  /** Display-only mode (e.g. builtin tools in the admin org scope). */
  readOnly?: boolean;
  tools: ConnectorTool[];
}

/** Trigger label key per uniform group permission; mixed groups read as custom. */
const GROUP_MODE_LABEL_KEY = {
  [ConnectorToolPermission.auto]: 'connector.permission.autoAll',
  [ConnectorToolPermission.disabled]: 'connector.permission.disableAll',
  [ConnectorToolPermission.needs_approval]: 'connector.permission.approvalAll',
} as const;

const ToolPermissionGroup = memo<ToolPermissionGroupProps>(
  ({ label, tools, onPermissionChange, onBatchPermission, readOnly }) => {
    const { t } = useTranslation('tool');
    const [expanded, setExpanded] = useState(true);
    // One batch write is in flight — lock the trigger so rapid switching cannot
    // overlap two writes against the same document.
    const [pending, setPending] = useState(false);

    const toolIds = useMemo(() => tools.map((tool) => tool.id), [tools]);

    // Uniform children drive the trigger label; anything mixed reads as custom.
    const groupMode = useMemo(() => {
      const permissions = new Set(tools.map((tool) => tool.permission));
      const only = permissions.size === 1 ? [...permissions][0] : undefined;
      return only && only in GROUP_MODE_LABEL_KEY ? only : undefined;
    }, [tools]);

    const applyBatch = useCallback(
      async (permission: ConnectorToolPermission) => {
        setPending(true);
        try {
          await onBatchPermission(toolIds, permission);
        } catch {
          // Failures are surfaced by the write path (toast / refetch).
        } finally {
          setPending(false);
        }
      },
      [onBatchPermission, toolIds],
    );

    if (tools.length === 0) return null;

    const triggerLabel = groupMode
      ? t(GROUP_MODE_LABEL_KEY[groupMode])
      : t('connector.permission.custom');

    const batchItems = [
      {
        key: 'auto',
        label: t('connector.permission.autoAll'),
        onClick: () => void applyBatch(ConnectorToolPermission.auto),
      },
      {
        key: 'approval',
        label: t('connector.permission.approvalAll'),
        onClick: () => void applyBatch(ConnectorToolPermission.needs_approval),
      },
      {
        key: 'disable',
        label: t('connector.permission.disableAll'),
        onClick: () => void applyBatch(ConnectorToolPermission.disabled),
      },
    ];

    return (
      <div>
        <div className={styles.groupHeader} onClick={() => setExpanded((e) => !e)}>
          <div className={styles.groupLabel}>
            {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
            {label}
            <span className={styles.badge}>{tools.length}</span>
          </div>

          {!readOnly && (
            <DropdownMenu disabled={pending} items={batchItems}>
              <Button
                disabled={pending}
                size="small"
                style={{ fontSize: 12, height: 26 }}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontalIcon size={12} />
                {triggerLabel}
                <ChevronDownIcon size={12} />
              </Button>
            </DropdownMenu>
          )}
        </div>

        {expanded && (
          <div>
            {tools.map((tool) => (
              <ToolPermissionRow
                key={tool.id}
                readOnly={readOnly}
                tool={tool}
                onPermissionChange={onPermissionChange}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);

ToolPermissionGroup.displayName = 'ToolPermissionGroup';

export default ToolPermissionGroup;
