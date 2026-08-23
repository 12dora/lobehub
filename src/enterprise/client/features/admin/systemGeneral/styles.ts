import { createStaticStyles, cssVar } from 'antd-style';

export const infraSettingsStyles = createStaticStyles(({ css }) => ({
  actionsRow: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  /**
   * An alert is the one body element that can grow without bound (a long server message, a
   * two-line description). It is capped here so one unhappy card cannot set the height of the
   * whole grid; the full text is repeated at the top of the 详情 modal.
   */
  bannerSlot: css`
    overflow: hidden;
    min-width: 0;
    max-block-size: 108px;
  `,
  /**
   * No `min-block-size`: the row already equalises the cards (`grid-auto-rows: 1fr`), so a floor
   * on top of it only buys empty space — every card in the grid grows to the tallest card's
   * height, and the floor made that height a constant instead of a measurement. The gap between
   * the last reading and the action row is the slack of ONE card against the tallest one, and
   * that is the only blank the grid should ever show.
   */
  card: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    min-width: 0;
    block-size: 100%;
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  /** The summary never scrolls: five rows and a footer are what the row height is measured from. */
  cardBody: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 12px;

    min-width: 0;
    min-block-size: 0;
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
    gap: 8px;
    margin-block-start: auto;
  `,
  /** Equal-height rows: every card is as tall as the tallest one in its row, and no taller. */
  grid: css`
    display: grid;
    grid-auto-rows: 1fr;
    grid-template-columns: 1fr;
    gap: 16px;
    align-items: stretch;

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

    padding-block-start: 8px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
  `,
  /** Guidance is a footnote on the card: two lines at most, the rest lives in 详情. */
  noticeClamp: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  `,
  /**
   * Modal chrome: the body is a column whose height is capped, and the ScrollArea inside it takes
   * the whole of that cap, so the header and the action row stay put while a long panel scrolls.
   *
   * Both halves of the pair are load-bearing. The column direction plus `min-block-size: 0` is what
   * gives the scroller a DEFINITE block size to resolve `flex: 1` against; without it the body is
   * an `overflow: hidden` box whose content is only capped, and the longest form (沙箱) loses its
   * last fields — including the footer of the form — to a clip with no way to scroll to them.
   */
  modalBody: css`
    overflow: hidden;
    display: flex;
    flex-direction: column;

    min-block-size: 0;
    max-block-size: 70vh;
  `,
  modalScroller: css`
    flex: 1;
    min-width: 0;
    min-block-size: 0;
  `,
  modalFooter: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
  `,
  modalSection: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    min-width: 0;
    padding-inline-end: 4px;
  `,
  title: css`
    display: flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
  `,
}));
