'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode } from 'react';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  body: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 16px;

    min-width: 0;
    min-height: 0;
  `,
  /**
   * Closes the page header (title + description + notice). One rule per page —
   * everything below it (banner, toolbar/tabs, content) belongs to the body.
   */
  divider: css`
    flex-shrink: 0;

    width: 100%;
    height: 1px;
    margin: 0;
    border: none;

    background: ${cssVar.colorBorderSecondary};
  `,
  fullHeight: css`
    height: 100%;
  `,
  header: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;

    margin-block-end: 4px;
  `,
  notice: css`
    display: block;
    margin-block-start: 4px;
  `,
  titleBlock: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  `,
  toolbar: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
}));

export interface AdminPageTemplateProps {
  /** Primary page actions (Create, Publish, …) */
  actions?: ReactNode;
  /** Optional banner (revision conflict, managed resource, …) */
  banner?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
  /**
   * Escape hatch for the rule that closes the page header. Defaults to `true`
   * whenever the page title is rendered (embedded `hideTitle` sub-pages get none —
   * the outer page already drew it) — pass `false` for surfaces that supply their
   * own separation.
   */
  divider?: boolean;
  /**
   * Stretch the page to the shell height so a master-detail / sticky-footer body
   * can fill the remaining space and scroll internally instead of growing the
   * whole admin shell.
   */
  fullHeight?: boolean;
  /** Suppress the page `<h1>` when embedded under an outer surface (e.g. a tab whose label already names it). */
  hideTitle?: boolean;
  /**
   * Center the page body and cap its width (form-style pages, parity with the user
   * settings panel). Omit on table/list pages so they keep using the full shell width.
   */
  maxWidth?: number | string;
  /**
   * Short status line tied to the page description (e.g. a policy restriction).
   * Rendered right below the description inside the title block — use `banner`
   * instead for standalone, boxed notices.
   */
  notice?: ReactNode;
  title: ReactNode;
  /** Filter bar / tabs above the main body */
  toolbar?: ReactNode;
}

/**
 * Narrow reusable admin page chrome for list/detail modules.
 *
 * Extracted as a presentation adapter so later modules (M04+) do not import
 * ordinary-user settings route pages. Intentionally small — no speculative
 * settings-page refactor in M03.
 */
const AdminPageTemplate = memo<AdminPageTemplateProps>(
  ({
    title,
    description,
    actions,
    toolbar,
    banner,
    children,
    divider,
    fullHeight,
    hideTitle,
    maxWidth,
    notice,
  }) => {
    // The rule belongs to the header, so it only exists when a header does.
    // Embedded sub-pages (hideTitle) sit under an outer page header + tab strip that already
    // drew the one rule this page gets; their own description stays rule-less.
    const showDivider = divider ?? !hideTitle;
    // Embedded sub-pages (hideTitle) that also drop description / notice / actions have nothing
    // to put in the header — rendering it anyway leaves its margin plus the page gap as a blank
    // band above the toolbar.
    const showHeader = !hideTitle || Boolean(description) || Boolean(notice) || Boolean(actions);

    return (
      <Flexbox
        className={fullHeight ? `${styles.body} ${styles.fullHeight}` : styles.body}
        gap={16}
        style={
          maxWidth === undefined ? undefined : { marginInline: 'auto', maxWidth, width: '100%' }
        }
      >
        {showHeader ? (
          <div className={styles.header}>
            <div className={styles.titleBlock}>
              {hideTitle ? null : (
                <Text as="h1" style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
                  {title}
                </Text>
              )}
              {description ? <Text type="secondary">{description}</Text> : null}
              {notice ? <div className={styles.notice}>{notice}</div> : null}
            </div>
            {actions ? <div className={styles.actions}>{actions}</div> : null}
          </div>
        ) : null}
        {showDivider ? <hr className={styles.divider} /> : null}
        {banner}
        {toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null}
        {children}
      </Flexbox>
    );
  },
);

AdminPageTemplate.displayName = 'AdminPageTemplate';

export default AdminPageTemplate;
