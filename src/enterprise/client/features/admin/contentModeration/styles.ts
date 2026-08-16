import { createStaticStyles, cssVar } from 'antd-style';

/** Shared chrome for the 内容审计 (content moderation) admin surface. */
export const moderationStyles = createStaticStyles(({ css }) => ({
  bar: css`
    position: relative;

    overflow: hidden;

    height: 8px;
    border-radius: 999px;

    background: ${cssVar.colorFillTertiary};
  `,
  barFill: css`
    height: 100%;
    border-radius: 999px;
    background: ${cssVar.colorPrimary};
  `,
  barFillHit: css`
    height: 100%;
    border-radius: 999px;
    background: ${cssVar.colorError};
  `,
  barRow: css`
    display: grid;
    grid-template-columns: minmax(96px, 1.2fr) minmax(0, 3fr) 84px;
    gap: 12px;
    align-items: center;
  `,
  barThreshold: css`
    position: absolute;
    inset-block: -2px;
    width: 2px;
    background: ${cssVar.colorTextTertiary};
  `,
  barValue: css`
    font-size: ${cssVar.fontSizeSM};
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorTextSecondary};
    text-align: end;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    min-width: 0;
    height: 100%;
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  cardBody: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;

    min-height: 0;
  `,
  cardFooter: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;

    margin-block-start: auto;
    padding-block-start: 8px;
  `,
  cardGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 16px;
    align-items: stretch;
  `,
  cardHeader: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
  chartGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 16px;
    align-items: stretch;
  `,
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    overflow-wrap: anywhere;
  `,
  empty: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;
    justify-content: center;

    min-height: 160px;
    padding: 24px;

    text-align: center;
  `,
  emptyDesc: css`
    margin: 0;
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
  emptyTitle: css`
    margin: 0;
    font-size: ${cssVar.fontSize};
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  excerpt: css`
    max-height: 320px;
    padding: 12px;
    border-radius: ${cssVar.borderRadius};

    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    overflow-wrap: anywhere;
    white-space: pre-wrap;

    background: ${cssVar.colorFillQuaternary};
  `,
  fieldLabel: css`
    flex: 0 0 40%;
    min-width: 0;
    color: ${cssVar.colorTextSecondary};
  `,
  fieldRow: css`
    display: flex;
    gap: 12px;
    align-items: baseline;
    justify-content: space-between;

    min-width: 0;
  `,
  fieldValue: css`
    min-width: 0;
    text-align: end;
    overflow-wrap: anywhere;
  `,
  formRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  `,
  hintText: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
  `,
  kpiGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
    gap: 12px;
  `,
  kpiLabel: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
  kpiTile: css`
    display: flex;
    flex-direction: column;
    gap: 6px;

    min-width: 0;
    padding-block: 12px;
    padding-inline: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  kpiValue: css`
    font-size: 22px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    color: ${cssVar.colorText};
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 16px;

    min-width: 0;
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  sectionDesc: css`
    margin: 0;
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
  sectionTitle: css`
    margin: 0;
    font-size: ${cssVar.fontSizeLG};
    font-weight: ${cssVar.fontWeightStrong};
    color: ${cssVar.colorText};
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  `,
  tableToolbar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    width: 100%;
  `,
  toolbarRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
}));
