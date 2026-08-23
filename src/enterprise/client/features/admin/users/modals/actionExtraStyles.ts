import { createStaticStyles, cssVar } from 'antd-style';

/** Shared layout for the inline `extra` blocks rendered inside the reason modals. */
export const actionExtraStyles = createStaticStyles(({ css }) => ({
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  hint: css`
    color: ${cssVar.colorTextSecondary};
  `,
  option: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
  `,
  roleBlock: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
  `,
  roleDesc: css`
    margin-inline-start: 24px;
    color: ${cssVar.colorTextSecondary};
  `,
}));
