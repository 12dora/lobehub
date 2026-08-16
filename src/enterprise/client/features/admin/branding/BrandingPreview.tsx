'use client';

import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo } from 'react';

import type { RuntimeBranding } from '@/enterprise/client/providers/runtimeBranding';
import type { AdminBrandingPayload } from '@/enterprise/client/services/adminBranding';

const styles = createStaticStyles(({ css }) => ({
  frame: css`
    width: 100%;
    min-height: 480px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
}));

const PRIMARY_COLOR = /^#[\da-f]{6}$/i;
const EMPTY = '—';

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const firstText = (...values: Array<string | null | undefined>): string => {
  for (const value of values) {
    if (value) return value;
  }
  return EMPTY;
};

export interface BrandingPreviewCopy {
  defaultAgent: string;
  defaultName: string;
  emailFrom: string;
  home: string;
  links: string;
  primaryColor: string;
  privacy: string;
  signIn: string;
  support: string;
  terms: string;
  workspace: string;
}

export interface BrandingPreviewProps {
  branding: AdminBrandingPayload;
  copy: BrandingPreviewCopy;
  /** Effective runtime branding used as fallback so empty fields preview current reality. */
  effective?: RuntimeBranding;
  title: string;
}

export const BrandingPreview = memo<BrandingPreviewProps>(
  ({ branding, copy, effective, title }) => {
    const source = useMemo(() => {
      const name = escapeHtml(branding.name ?? effective?.name ?? copy.defaultName);
      const shortName = escapeHtml(branding.shortName ?? effective?.shortName ?? name);
      const logoUrl = branding.logoUrl ?? effective?.logoUrl;
      const logo = logoUrl
        ? `<img alt="" src="${escapeHtml(logoUrl)}" style="max-height:44px;max-width:180px;object-fit:contain" />`
        : `<div style="font-size:22px;font-weight:700">${shortName}</div>`;
      const agent = escapeHtml(
        branding.defaultAgentDisplayName ?? effective?.defaultAgentDisplayName ?? `${name} AI`,
      );
      const pageTitle = escapeHtml(
        (branding.pageTitleTemplate ?? effective?.pageTitleTemplate ?? `%s · ${name}`).replace(
          '%s',
          copy.workspace,
        ),
      );
      const rawColor =
        branding.themeDefaults.primaryColor ?? effective?.themeDefaults?.primaryColor ?? null;
      const safeColor = rawColor && PRIMARY_COLOR.test(rawColor) ? rawColor : null;
      const colorSwatch = safeColor
        ? `<span style="display:inline-block;width:16px;height:16px;margin-right:8px;border:1px solid #e5e7eb;border-radius:4px;background:${safeColor};vertical-align:middle"></span><code>${escapeHtml(safeColor)}</code>`
        : EMPTY;
      const sender =
        branding.emailSenderName ??
        effective?.emailSenderName ??
        branding.name ??
        effective?.name ??
        copy.defaultName;
      const emailFrom = branding.emailFrom ?? effective?.emailFrom;
      const fromLine = `${sender} <${emailFrom || EMPTY}>`;
      const meta = `<aside style="padding:16px 24px;border-top:1px solid #e5e7eb;background:white;font-size:13px;color:#344054"><div style="margin:0 0 12px">${escapeHtml(copy.primaryColor)}: ${colorSwatch}</div><div style="margin:0 0 8px;font-weight:600">${escapeHtml(copy.links)}</div><ul style="margin:0 0 12px;padding-left:18px"><li>${escapeHtml(copy.home)}: ${escapeHtml(firstText(branding.homeUrl, effective?.homeUrl))}</li><li>${escapeHtml(copy.support)}: ${escapeHtml(firstText(branding.supportUrl, effective?.supportUrl))}</li><li>${escapeHtml(copy.privacy)}: ${escapeHtml(firstText(branding.privacyUrl, effective?.privacyUrl))}</li><li>${escapeHtml(copy.terms)}: ${escapeHtml(firstText(branding.termsUrl, effective?.termsUrl))}</li></ul><div>${escapeHtml(copy.emailFrom)}: ${escapeHtml(fromLine)}</div></aside>`;
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${pageTitle}</title></head><body style="margin:0;background:#f6f7f9;color:#1f2329;font:14px system-ui"><header style="display:flex;align-items:center;justify-content:space-between;padding:16px 24px;background:white;border-bottom:1px solid #e5e7eb">${logo}<span>${pageTitle}</span></header><main style="display:grid;place-items:center;min-height:220px;padding:24px"><section style="width:min(360px,100%);box-sizing:border-box;padding:24px;border:1px solid #e5e7eb;border-radius:16px;background:white"><h1 style="margin:0 0 8px">${name}</h1><p style="margin:0 0 20px;color:#667085">${escapeHtml(copy.signIn)}</p><div style="padding:12px;border-radius:10px;background:#f4f5f7">${escapeHtml(copy.defaultAgent)}: <strong>${agent}</strong></div></section></main>${meta}</body></html>`;
    }, [branding, copy, effective]);

    return <iframe className={styles.frame} sandbox="" srcDoc={source} title={title} />;
  },
);

BrandingPreview.displayName = 'BrandingPreview';
