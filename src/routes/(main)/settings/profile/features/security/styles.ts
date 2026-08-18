import { createStaticStyles, cssVar } from 'antd-style';

/** Shared chrome for the imperative security modals (they render `title: null` and own their header). */
export const securityStyles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
  `,
  danger: css`
    color: ${cssVar.colorError};
  `,
  /** `Text` renders a block with a UA margin; the flex gap is the only spacing we want. */
  desc: css`
    margin: 0;
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextDescription};
  `,
  divider: css`
    height: 1px;
    margin-block: 0;
    border: none;
    background: ${cssVar.colorBorderSecondary};
  `,
  /** A run of form fields reads as one unit, so it sits tighter than the gap between blocks. */
  fields: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  footer: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
  `,
  /**
   * A secondary action on the left, the primary group on the right — but the modal is as
   * narrow as ~262px of content on a 320px viewport and the labels are translated, so the
   * row must be able to break. It wraps instead of overflowing (the modal clips), and the
   * leading item's auto margin keeps the split on one line when there is room and leaves
   * the trailing group right-aligned once it drops to its own line.
   */
  footerSpread: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: center;
    justify-content: flex-end;

    > :first-child {
      margin-inline-end: auto;
    }
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  sectionHead: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  `,
  /** Heading of a block inside a modal — one step below the modal's own title. */
  sectionTitle: css`
    margin: 0;
    font-size: ${cssVar.fontSize};
    font-weight: 600;
  `,
  title: css`
    margin: 0;
    font-size: ${cssVar.fontSizeLG};
    font-weight: 600;
  `,
}));
