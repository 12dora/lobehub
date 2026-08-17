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
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
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
  /* Row 1 of 概况: trend takes the wider track, the category donut sits beside it. */
  chartRowPrimary: css`
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(360px, 2fr);
    gap: 16px;
    align-items: stretch;

    @media (width <= 1100px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  /* Row 2 of 概况: users / sources / request kinds side by side. */
  chartRowSecondary: css`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    align-items: stretch;

    @media (width <= 1100px) {
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }
  `,
  donutLayout: css`
    display: grid;
    grid-template-columns: minmax(180px, 220px) minmax(0, 1fr);
    gap: 16px;
    align-items: center;
  `,
  donutLegend: css`
    display: flex;
    flex-direction: column;
    gap: 2px;

    margin: 0;
    padding: 0;

    list-style: none;
  `,
  donutLegendButton: css`
    cursor: pointer;

    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;

    width: 100%;
    padding-block: 4px;
    padding-inline: 6px;
    border: none;
    border-radius: ${cssVar.borderRadiusSM};

    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorText};
    text-align: start;

    background: none;

    &:hover,
    &:focus-visible {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  donutLegendItem: css`
    &[data-active='true'] > button {
      background: ${cssVar.colorFillSecondary};
    }
  `,
  donutLegendName: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  donutLegendValue: css`
    font-variant-numeric: tabular-nums;
    color: ${cssVar.colorTextSecondary};
  `,
  donutSwatch: css`
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 3px;
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
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  `,
  /* Two-up form grid inside a settings section; falls back to one column when narrow. */
  fieldGrid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px 32px;
    align-items: start;

    @media (width <= 900px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  fieldLabel: css`
    flex: 0 0 40%;
    min-width: 0;
    color: ${cssVar.colorTextSecondary};
  `,
  fieldLabelRow: css`
    display: flex;
    gap: 4px;
    align-items: center;
    min-height: 20px;
  `,
  fieldWide: css`
    grid-column: 1 / -1;
  `,
  helpButton: css`
    cursor: help;

    display: inline-flex;
    align-items: center;

    padding: 0;
    border: none;

    color: ${cssVar.colorTextTertiary};

    background: none;

    &:hover,
    &:focus-visible {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  /* Category policy row: name | action | threshold — fixed tracks so a long name never squeezes the controls. */
  categoryGrid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 32px;

    @media (width <= 900px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  categoryRow: css`
    display: grid;
    grid-template-columns: minmax(0, 1fr) 128px 96px;
    gap: 12px;
    align-items: center;
  `,
  divider: css`
    height: 1px;
    margin: 0;
    border: none;
    background: ${cssVar.colorBorderSecondary};
  `,
  inlineSwitch: css`
    display: flex;
    gap: 8px;
    align-items: center;
    min-height: 32px;
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
  statsToolbar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
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
