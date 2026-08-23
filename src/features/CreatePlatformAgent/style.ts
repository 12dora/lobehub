import { createStaticStyles, cssVar } from 'antd-style';

export const styles = createStaticStyles(({ css }) => ({
  avatarPreview: css`
    display: flex;
    align-items: center;
    justify-content: center;

    width: 48px;
    height: 48px;
    border-radius: ${cssVar.borderRadiusLG};

    font-size: 28px;
    line-height: 1;

    background: ${cssVar.colorFillSecondary};
  `,
  deviceItem: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,
  platformCard: css`
    cursor: pointer;

    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-start;

    padding-block: 12px;
    padding-inline: 16px;
    border: 1.5px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};

    transition: border-color 0.2s;

    &:hover {
      border-color: ${cssVar.colorPrimary};
    }

    &[data-selected='true'] {
      border-color: ${cssVar.colorPrimary};
      background: ${cssVar.colorPrimaryBg};
    }

    &[data-disabled='true'] {
      cursor: not-allowed;
      opacity: 0.5;

      &:hover {
        border-color: ${cssVar.colorBorderSecondary};
      }
    }
  `,
  platformDesc: css`
    font-size: 13px;
    color: ${cssVar.colorTextSecondary};
  `,
  platformName: css`
    font-size: 15px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
}));
