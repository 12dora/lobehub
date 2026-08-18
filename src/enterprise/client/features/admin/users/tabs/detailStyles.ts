import { createStaticStyles, cssVar } from 'antd-style';

/**
 * Shared rhythm for the user detail tabs (slide-in panel at 560px and the full page).
 *
 * One label column of 96px keeps every fact grid aligned across sections; 13px body text
 * with 6px row gaps reads as a dense but breathable "record card" instead of a form.
 */
export const detailStyles = createStaticStyles(({ css }) => ({
  /** Small button row under a section. */
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  `,
  /** Facts grid: label · value. */
  dl: css`
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 6px 12px;

    margin: 0;

    font-size: 13px;
    line-height: 22px;

    dt {
      overflow: hidden;
      color: ${cssVar.colorTextSecondary};
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    dd {
      min-width: 0;
      margin: 0;
      overflow-wrap: anywhere;
    }
  `,
  /** Whole tab: sections stacked with a hairline between them. */
  root: css`
    display: flex;
    flex-direction: column;
    gap: 16px;

    > section + section {
      padding-block-start: 16px;
      border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    }
  `,
  /** One titled block. */
  section: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  `,
  sectionHeader: css`
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    min-height: 24px;
  `,
  sectionTitle: css`
    margin: 0;

    font-size: 13px;
    font-weight: 600;
    line-height: 22px;
    color: ${cssVar.colorText};
  `,
}));
