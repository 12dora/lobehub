'use client';

import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo } from 'react';

import type { AdminBrandingDraft } from '@/server/enterprise/contracts/adminBranding';

const styles = createStaticStyles(({ css }) => ({
  frame: css`
    width: 100%;
    min-height: 360px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
}));

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export interface BrandingPreviewProps {
  copy: {
    defaultAgent: string;
    defaultName: string;
    signIn: string;
    workspace: string;
  };
  draft: AdminBrandingDraft;
  title: string;
}

export const BrandingPreview = memo<BrandingPreviewProps>(({ copy, draft, title }) => {
  const source = useMemo(() => {
    const name = escapeHtml(draft.name ?? copy.defaultName);
    const shortName = escapeHtml(draft.shortName ?? name);
    const logo = draft.logoUrl
      ? `<img alt="" src="${escapeHtml(draft.logoUrl)}" style="max-height:44px;max-width:180px;object-fit:contain" />`
      : `<div style="font-size:22px;font-weight:700">${shortName}</div>`;
    const agent = escapeHtml(draft.defaultAgentDisplayName ?? `${name} AI`);
    const pageTitle = escapeHtml(
      (draft.pageTitleTemplate ?? `%s · ${name}`).replace('%s', copy.workspace),
    );
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${pageTitle}</title></head><body style="margin:0;background:#f6f7f9;color:#1f2329;font:14px system-ui"><header style="display:flex;align-items:center;justify-content:space-between;padding:16px 24px;background:white;border-bottom:1px solid #e5e7eb">${logo}<span>${pageTitle}</span></header><main style="display:grid;place-items:center;min-height:285px;padding:24px"><section style="width:min(360px,100%);box-sizing:border-box;padding:24px;border:1px solid #e5e7eb;border-radius:16px;background:white"><h1 style="margin:0 0 8px">${name}</h1><p style="margin:0 0 20px;color:#667085">${escapeHtml(copy.signIn)}</p><div style="padding:12px;border-radius:10px;background:#f4f5f7">${escapeHtml(copy.defaultAgent)}: <strong>${agent}</strong></div></section></main></body></html>`;
  }, [copy, draft]);

  return <iframe className={styles.frame} sandbox="" srcDoc={source} title={title} />;
});

BrandingPreview.displayName = 'BrandingPreview';
