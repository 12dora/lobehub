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
  `,
  header: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-start;
    justify-content: space-between;

    margin-block-end: 4px;
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

    padding-block-end: 8px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
}));

export interface AdminPageTemplateProps {
  /** Primary page actions (Create, Publish, …) */
  actions?: ReactNode;
  /** Optional banner (revision conflict, managed resource, …) */
  banner?: ReactNode;
  children: ReactNode;
  description?: ReactNode;
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
  ({ title, description, actions, toolbar, banner, children }) => {
    return (
      <Flexbox className={styles.body} gap={16}>
        <div className={styles.header}>
          <div className={styles.titleBlock}>
            <Text as="h1" style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
              {title}
            </Text>
            {description ? <Text type="secondary">{description}</Text> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </div>
        {banner}
        {toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null}
        {children}
      </Flexbox>
    );
  },
);

AdminPageTemplate.displayName = 'AdminPageTemplate';

export default AdminPageTemplate;
