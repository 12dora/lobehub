import { createStaticStyles, cssVar } from 'antd-style';

export const identityProviderStyles = createStaticStyles(({ css }) => ({
  callback: css`
    display: flex;
    gap: 8px;
    align-items: flex-start;
    justify-content: space-between;

    padding-block: 10px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorFillQuaternary};
  `,
  callbackUrl: css`
    min-width: 0;
    font-family: ${cssVar.fontFamilyCode};
    overflow-wrap: anywhere;
  `,
  card: css`
    display: flex;
    flex-direction: column;
    gap: 6px;

    padding: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  cardActive: css`
    border-color: ${cssVar.colorPrimary};
    box-shadow: 0 0 0 1px ${cssVar.colorPrimaryBorder};
  `,
  cardButton: css`
    cursor: pointer;
    text-align: start;

    &:hover {
      border-color: ${cssVar.colorPrimaryBorderHover};
    }
  `,
  columns: css`
    display: grid;
    grid-template-columns: minmax(240px, 0.3fr) minmax(0, 1fr);
    gap: 16px;
    align-items: start;

    @media (width <= 840px) {
      grid-template-columns: 1fr;
    }
  `,
  discoveryGrid: css`
    display: grid;
    gap: 8px;

    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorFillQuaternary};
  `,
  discoveryRow: css`
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 8px;

    @media (width <= 560px) {
      grid-template-columns: 1fr;
    }
  `,
  corpTable: css`
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
  `,
  corpTableHead: css`
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1.2fr) auto;
    gap: 12px;
    align-items: center;

    padding-block: 8px;
    padding-inline: 12px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillQuaternary};

    @media (width <= 640px) {
      display: none;
    }
  `,
  corpTableRow: css`
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1.2fr) auto;
    gap: 12px;
    align-items: center;

    padding-block: 10px;
    padding-inline: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
  corpId: css`
    overflow: hidden;

    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  endpointValue: css`
    font-family: ${cssVar.fontFamilyCode};
    overflow-wrap: anywhere;
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  form: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;

    @media (width <= 760px) {
      grid-template-columns: 1fr;
    }
  `,
  full: css`
    grid-column: 1 / -1;
  `,
  instance: css`
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;

    padding-block: 6px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  meta: css`
    font-family: ${cssVar.fontFamilyCode};
    overflow-wrap: anywhere;
  `,
  panel: css`
    display: flex;
    flex-direction: column;
    gap: 16px;

    padding: 18px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  revision: css`
    font-family: ${cssVar.fontFamilyCode};
    overflow-wrap: anywhere;
  `,
  restartActivity: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
  `,
  restartActivityAnimated: css`
    @media (prefers-reduced-motion: reduce) {
      display: none;
    }
  `,
  restartActivityStatic: css`
    display: none;
    color: ${cssVar.colorInfo};

    @media (prefers-reduced-motion: reduce) {
      display: inline;
    }
  `,
  setupList: css`
    margin: 0;
    padding-inline-start: 18px;

    li {
      margin-block: 4px;
    }
  `,
  stack: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  templateGrid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
  templateCard: css`
    cursor: pointer;

    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    text-align: start;

    background: ${cssVar.colorBgContainer};

    transition: border-color 0.15s ease;

    &:hover {
      border-color: ${cssVar.colorPrimary};
    }
  `,
}));
