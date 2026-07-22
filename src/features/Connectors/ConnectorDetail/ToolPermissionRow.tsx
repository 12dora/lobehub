import { Tooltip } from 'antd';
import { createStaticStyles } from 'antd-style';
import { BanIcon, CheckIcon, HandIcon } from 'lucide-react';
import { memo } from 'react';

import { ConnectorToolPermission } from '@/database/schemas';
import type { ConnectorTool } from '@/store/tool/slices/connector';

const styles = createStaticStyles(({ css, cssVar }) => ({
  btn: css`
    cursor: pointer;

    display: flex;
    align-items: center;
    justify-content: center;

    width: 28px;
    height: 28px;
    border-radius: 6px;

    color: ${cssVar.colorTextQuaternary};

    transition:
      color 0.15s,
      background 0.15s;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }
  `,
  btnActive: css`
    color: ${cssVar.colorPrimary};
    background: ${cssVar.colorPrimaryBg};

    &:hover {
      color: ${cssVar.colorPrimary};
      background: ${cssVar.colorPrimaryBgHover};
    }
  `,
  description: css`
    overflow: hidden;

    font-size: 11px;
    line-height: 1.4;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  nameCell: css`
    overflow: hidden;
    flex: 1;
    min-width: 0;
  `,
  row: css`
    display: flex;
    gap: 8px;
    align-items: center;

    padding-block: 8px;
    padding-inline: 12px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    &:last-child {
      border-block-end: none;
    }

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }
  `,
  toolName: css`
    overflow: hidden;

    font-family: var(--font-mono, monospace);
    font-size: 13px;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

interface ToolPermissionRowProps {
  onPermissionChange: (toolId: string, permission: ConnectorToolPermission) => void;
  /** Display-only mode (e.g. builtin tools in the admin org scope). */
  readOnly?: boolean;
  tool: ConnectorTool;
}

const ToolPermissionRow = memo<ToolPermissionRowProps>(({ tool, onPermissionChange, readOnly }) => {
  const btnClass = (permission: ConnectorToolPermission) =>
    tool.permission === permission ? `${styles.btn} ${styles.btnActive}` : styles.btn;
  const change = (permission: ConnectorToolPermission) => {
    if (readOnly) return;
    onPermissionChange(tool.id, permission);
  };
  const btnStyle = readOnly ? { cursor: 'default', opacity: 0.55 } : undefined;

  return (
    <div className={styles.row}>
      <div className={styles.nameCell}>
        <div className={styles.toolName}>{tool.toolName}</div>
        {tool.description && (
          <Tooltip mouseEnterDelay={0.5} title={tool.description}>
            <div className={styles.description}>{tool.description}</div>
          </Tooltip>
        )}
      </div>
      <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
        <div
          className={btnClass(ConnectorToolPermission.auto)}
          style={btnStyle}
          title="Auto — AI calls directly"
          onClick={() => change(ConnectorToolPermission.auto)}
        >
          <CheckIcon size={15} />
        </div>
        <div
          className={btnClass(ConnectorToolPermission.needs_approval)}
          style={btnStyle}
          title="Needs approval"
          onClick={() => change(ConnectorToolPermission.needs_approval)}
        >
          <HandIcon size={15} />
        </div>
        <div
          className={btnClass(ConnectorToolPermission.disabled)}
          style={btnStyle}
          title="Disabled — hidden from AI"
          onClick={() => change(ConnectorToolPermission.disabled)}
        >
          <BanIcon size={15} />
        </div>
      </div>
    </div>
  );
});

ToolPermissionRow.displayName = 'ToolPermissionRow';

export default ToolPermissionRow;
