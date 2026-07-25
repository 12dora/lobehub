import { createStaticStyles, cssVar } from 'antd-style';

/** Shared width for policy-mode selects so resource + sidebar tiles stay aligned. */
export const POLICY_MODE_SELECT_WIDTH = 180;

/**
 * Card/row chrome shared by ManagedResourcesPolicyPage tiles and SidebarLayoutControl.
 * Keep a single owner so equal-height grid tiles do not drift.
 */
export const managedResourcePolicyCardStyles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  row: css`
    display: flex;
    flex-wrap: nowrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
  `,
}));
