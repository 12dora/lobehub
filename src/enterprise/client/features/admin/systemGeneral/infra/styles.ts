import { createStaticStyles, cssVar } from 'antd-style';

/** Chrome for the editable 基础设施 forms (object storage / mail). */
export const infraFormStyles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  error: css`
    font-size: ${cssVar.fontSizeSM};
    line-height: 1.5;
    color: ${cssVar.colorError};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  `,
  /* Two-up form grid; collapses to one column on narrow cards. */
  fieldGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px 16px;
    align-items: start;
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
  hint: css`
    font-size: ${cssVar.fontSizeSM};
    line-height: 1.5;
    color: ${cssVar.colorTextTertiary};
  `,
  label: css`
    font-size: 13px;
    font-weight: 500;
    line-height: 20px;
    color: ${cssVar.colorText};
  `,
  labelRow: css`
    display: flex;
    gap: 4px;
    align-items: center;
    min-height: 20px;
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  `,
  switchField: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  `,
  switchRow: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    min-width: 0;
  `,
}));
