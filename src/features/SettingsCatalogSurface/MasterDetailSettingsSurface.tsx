'use client';

import { Center, Empty, type EmptyProps, Flexbox, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { ReactNode } from 'react';
import { memo } from 'react';

/**
 * Canonical master-detail chrome for Settings-style catalog surfaces
 * (skills / connectors). Shared by user `/settings/*` managed paths and
 * admin `/admin/ai/*` parity pages so layout, empty selection, and panel
 * geometry stay one implementation.
 */
const styles = createStaticStyles(({ css }) => ({
  advancedLink: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-decoration: none;

    &:hover {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  body: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    min-height: 0;
  `,
  content: css`
    overflow: auto;
    flex: 1;
    min-width: 0;
  `,
  detail: css`
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  `,
  left: css`
    overflow: hidden;
    display: flex;
    flex-direction: column;

    width: 300px;
    min-width: 260px;
    min-height: 0;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  leftBody: css`
    overflow-y: auto;
    flex: 1;

    min-height: 0;
    padding-block: 4px;
    padding-inline: 8px;
  `,
  leftHeader: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    height: 42px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  root: css`
    overflow: hidden;
    display: flex;
    flex: 1;

    height: 100%;
    min-height: 0;
  `,
  shell: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  `,
  toolbar: css`
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 8px 12px;
    padding-inline: 4px;
  `,
}));

const detailStyles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 24px;
  `,
  card: css`
    display: grid;
    grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
    gap: 10px 16px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
  `,
  description: css`
    line-height: 1.6;
    color: ${cssVar.colorTextSecondary};
  `,
  header: css`
    display: flex;
    flex-direction: column;
    gap: 6px;

    padding-block: 20px 16px;
    padding-inline: 24px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
}));

export const masterDetailSurfaceStyles = styles;
export const catalogDetailStyles = detailStyles;

export interface MasterDetailSettingsSurfaceProps {
  detail: ReactNode | null;
  /** Optional banner strip above the detail pane (draft publish, policy notice). */
  detailBanner?: ReactNode;
  /** Empty state when no detail is selected. */
  emptySelection?: {
    description: ReactNode;
    /** Matches `@lobehub/ui` Empty `icon` (Lucide/FC/ReactNode). */
    icon?: EmptyProps['icon'];
    title: ReactNode;
  };
  leftActions?: ReactNode;
  leftBody: ReactNode;
  leftTitle: ReactNode;
  /** Optional page-level toolbar (title + advanced link). Admin pages use this. */
  toolbar?: ReactNode;
}

const MasterDetailSettingsSurface = memo<MasterDetailSettingsSurfaceProps>(
  ({ toolbar, detailBanner, leftTitle, leftActions, leftBody, detail, emptySelection }) => {
    return (
      <div className={toolbar ? styles.shell : styles.root}>
        {toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null}
        <div className={toolbar ? styles.body : styles.root}>
          <div className={styles.left}>
            <div className={styles.leftHeader}>
              <Text strong style={{ fontSize: 14 }}>
                {leftTitle}
              </Text>
              {leftActions ? (
                <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  {leftActions}
                </div>
              ) : null}
            </div>
            <div className={styles.leftBody}>{leftBody}</div>
          </div>
          <div className={styles.content}>
            {detailBanner ? <div style={{ padding: '12px 24px 0' }}>{detailBanner}</div> : null}
            {detail ? (
              <div className={styles.detail}>{detail}</div>
            ) : emptySelection ? (
              <Center paddingBlock={64}>
                <Empty
                  description={emptySelection.description}
                  icon={emptySelection.icon}
                  title={emptySelection.title}
                />
              </Center>
            ) : null}
          </div>
        </div>
      </div>
    );
  },
);

MasterDetailSettingsSurface.displayName = 'MasterDetailSettingsSurface';

export interface CatalogSurfaceToolbarProps {
  advancedHref?: string;
  advancedLabel?: ReactNode;
  description: ReactNode;
  /** Render prop for advanced link so callers can use react-router Link. */
  renderAdvancedLink?: (href: string, label: ReactNode, className: string) => ReactNode;
  title: ReactNode;
}

export const CatalogSurfaceToolbar = memo<CatalogSurfaceToolbarProps>(
  ({ title, description, advancedHref, advancedLabel, renderAdvancedLink }) => (
    <>
      <div>
        <Text as="h1" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
          {title}
        </Text>
        <Text style={{ fontSize: 12 }} type="secondary">
          {description}
        </Text>
      </div>
      {advancedHref && advancedLabel && renderAdvancedLink
        ? renderAdvancedLink(advancedHref, advancedLabel, styles.advancedLink)
        : null}
    </>
  ),
);

CatalogSurfaceToolbar.displayName = 'CatalogSurfaceToolbar';

export const CatalogDetailChrome = memo<{
  children: ReactNode;
  description?: ReactNode;
  title: ReactNode;
  tags?: ReactNode;
}>(({ children, description, title, tags }) => (
  <>
    <header className={detailStyles.header}>
      <Flexbox horizontal align="center" gap={8} justify="space-between">
        <Text strong as="h2">
          {title}
        </Text>
        {tags}
      </Flexbox>
      {description ? <span className={detailStyles.description}>{description}</span> : null}
    </header>
    <main className={detailStyles.body}>{children}</main>
  </>
));

CatalogDetailChrome.displayName = 'CatalogDetailChrome';

export default MasterDetailSettingsSurface;
