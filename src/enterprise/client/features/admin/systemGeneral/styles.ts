import { createStaticStyles, cssVar } from 'antd-style';

export const infraSettingsStyles = createStaticStyles(({ css }) => ({
  actionsRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: 16px;

    min-width: 0;
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  cardBody: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 16px;

    min-height: 0;
  `,
  code: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  `,
  envList: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  `,
  envChip: css`
    padding-block: 2px;
    padding-inline: 6px;
    border-radius: ${cssVar.borderRadiusXS};

    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    line-height: 1.4;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillTertiary};
  `,
  fieldLabel: css`
    flex: 0 0 36%;
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
  fields: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  `,
  footer: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-block-start: auto;
  `,
  /*
   * Each card is its own height. The columns used to stretch to the tallest card, which reads well
   * for two cards of similar length but turns a folded card into a header floating over its own
   * empty box — and a stretched card cannot animate its height honestly either.
   */
  grid: css`
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
    align-items: start;

    @media (width >= 1024px) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  `,
  header: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  `,
  /** The same header row, as the accordion's title: it has to claim the width the chevron leaves. */
  headerInAccordion: css`
    flex: 1;
    min-width: 0;
  `,
  headerTags: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  `,
  hint: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  title: css`
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
  `,
}));
