import { createStaticStyles, cssVar } from 'antd-style';

/** Shared chrome for the imperative security modals (they render `title: null` and own their header). */
export const securityStyles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  danger: css`
    color: ${cssVar.colorError};
  `,
  desc: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextDescription};
  `,
  divider: css`
    height: 1px;
    margin-block: 0;
    border: none;
    background: ${cssVar.colorBorderSecondary};
  `,
  footer: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
  `,
  footerSpread: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  sectionHead: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  `,
  title: css`
    margin: 0;
    font-size: ${cssVar.fontSizeLG};
    font-weight: 600;
  `,
}));
