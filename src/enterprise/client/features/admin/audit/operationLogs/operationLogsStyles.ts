'use client';

import { createStaticStyles, cssVar } from 'antd-style';

export const styles = createStaticStyles(({ css }) => ({
  statCard: css`
    cursor: pointer;

    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;

    min-width: 120px;
    padding-block: 12px;
    padding-inline: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};

    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;

    &:hover {
      background: ${cssVar.colorFillQuaternary};
    }

    &:focus-visible {
      outline: 2px solid ${cssVar.colorPrimaryBorder};
      outline-offset: 2px;
    }

    /* Soft filled selected state — hue-independent, no outline ring. */
    &[data-active='true'] {
      border-color: transparent;
      background: ${cssVar.colorFillTertiary};
    }
  `,
  statValue: css`
    margin: 0;
    font-size: 22px;
    font-weight: 700;
    line-height: 1.2;
  `,
  stats: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  `,
  tableToolbar: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    width: 100%;
  `,
  timeRange: css`
    width: min(360px, 100%);

    &&.ant-picker {
      height: 36px;
    }
  `,
}));
