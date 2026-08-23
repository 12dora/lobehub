'use client';

import { createStaticStyles, cssVar } from 'antd-style';

export const styles = createStaticStyles(({ css }) => ({
  banner: css`
    padding-block: 10px;
    padding-inline: 14px;
    border: 1px solid ${cssVar.colorWarningBorder};
    border-radius: ${cssVar.borderRadius};

    background: ${cssVar.colorWarningBg};
  `,
  message: css`
    display: flex;
    flex-direction: column;
    gap: 6px;

    padding-block: 12px;
    padding-inline: 14px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  body: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: 13px;
    line-height: 1.55;
    word-break: break-word;
    white-space: pre-wrap;
  `,
  redacted: css`
    font-weight: 600;
    color: ${cssVar.colorWarning};
  `,
  stream: css`
    display: flex;
    flex-direction: column;
    gap: 10px;
  `,
}));
