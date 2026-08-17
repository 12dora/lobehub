import { createStaticStyles, cssVar } from 'antd-style';

export const policyPageStyles = createStaticStyles(({ css }) => ({
  footer: css`
    position: sticky;
    z-index: 2;
    inset-block-end: 0;

    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgLayout};
  `,
  grid: css`
    display: grid;

    /* Equal-height rows so every managed-resource box lines up as a uniform tile. */
    grid-auto-rows: 1fr;

    /* Cards stay readable; do not force all boxes into one cramped row. 320px leaves room
       for the title next to the fixed-width mode select so long labels don't truncate. */
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
  `,
  status: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));
