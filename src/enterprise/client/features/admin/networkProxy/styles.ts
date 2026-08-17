import { createStaticStyles, cssVar } from 'antd-style';

/** Shared chrome for the 网络代理 (network proxy) admin tab. */
export const networkProxyStyles = createStaticStyles(({ css }) => ({
  badgeRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;

    min-width: 0;
  `,
  /** Engine block: instance facts on the left, the dependency panel on the right. */
  splitRow: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr));
    gap: 20px;
    align-items: start;
  `,
  depsPanel: css`
    display: flex;
    flex-direction: column;

    min-width: 0;
    padding-block: 12px;
    padding-inline: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorFillQuaternary};
  `,
  depRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;

    padding-block: 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  depMeta: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  `,
  depTitleRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;

    min-width: 0;
  `,
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  `,
  fieldGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px;
    align-items: start;
  `,
  headerBar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 12px;
    padding-inline: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  headerPrimary: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;

    min-width: 0;
  `,
  hintText: css`
    font-size: ${cssVar.fontSizeSM};
    line-height: 1.5;
    color: ${cssVar.colorTextTertiary};
  `,
  inlineActions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  logLine: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    line-height: 1.6;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  `,
  logPanel: css`
    overflow: auto;

    max-height: 60vh;
    padding: 12px;
    border-radius: ${cssVar.borderRadiusSM};

    background: ${cssVar.colorFillQuaternary};
  `,
  progressTrack: css`
    overflow: hidden;

    width: 100%;
    max-width: 320px;
    height: 6px;
    border-radius: 999px;

    background: ${cssVar.colorFillTertiary};
  `,
  progressValue: css`
    height: 100%;
    border-radius: 999px;
    background: ${cssVar.colorPrimary};
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
  sectionHeader: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;
  `,
  sectionTitle: css`
    margin: 0;
    font-size: ${cssVar.fontSize};
    font-weight: 600;
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  `,
  tableCaption: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
  `,
  toolbarRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  `,
}));
