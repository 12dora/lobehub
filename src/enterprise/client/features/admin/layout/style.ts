import { createStaticStyles, cssVar } from 'antd-style';

export const adminShellStyles = createStaticStyles(({ css }) => ({
  brand: css`
    font-size: 14px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  breadcrumb: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;

    font-size: 13px;
    color: ${cssVar.colorTextSecondary};

    a {
      color: ${cssVar.colorTextSecondary};
      text-decoration: none;

      &:hover {
        color: ${cssVar.colorText};
      }

      &:focus-visible {
        border-radius: 2px;
        outline: 2px solid ${cssVar.colorPrimary};
        outline-offset: 2px;
      }
    }
  `,
  content: css`
    overflow: auto;
    flex: 1;

    min-width: 0;
    padding-block: 20px;
    padding-inline: 24px;
  `,
  header: css`
    display: flex;
    flex-shrink: 0;
    gap: 16px;
    align-items: center;
    justify-content: space-between;

    height: 52px;
    padding-inline: 20px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgContainer};
  `,
  main: css`
    display: flex;
    flex: 1;
    flex-direction: column;

    min-width: 0;

    background: ${cssVar.colorBgLayout};
  `,
  navItem: css`
    display: block;

    padding-block: 8px;
    padding-inline: 12px;
    border-radius: ${cssVar.borderRadius}px;

    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
    text-decoration: none;

    transition:
      background 0.15s ease,
      color 0.15s ease;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimary};
      outline-offset: 2px;
    }

    &[data-active='true'] {
      font-weight: 600;
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }
  `,
  navSection: css`
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-block-end: 8px;
  `,
  root: css`
    display: flex;

    width: 100%;
    height: 100%;
    min-height: 100vh;

    color: ${cssVar.colorText};

    background: ${cssVar.colorBgLayout};
  `,
  sideNav: css`
    overflow: auto;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: 4px;

    width: 220px;
    padding-block: 12px;
    padding-inline: 10px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgContainer};
  `,
  sideNavLabel: css`
    padding-block: 8px 4px;
    padding-inline: 12px;

    font-size: 11px;
    font-weight: 600;
    color: ${cssVar.colorTextTertiary};
    text-transform: uppercase;
    letter-spacing: 0.04em;
  `,
  stateCenter: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
    justify-content: center;

    width: 100%;
    min-height: 100vh;
    padding: 24px;

    text-align: center;
  `,
}));
