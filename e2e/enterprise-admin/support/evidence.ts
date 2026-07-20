import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Browser, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { VIEWPORTS } from './selectors';

export const EVIDENCE_ROOT =
  process.env.E2E_ENTERPRISE_ADMIN_EVIDENCE_DIR ??
  path.resolve(__dirname, '../../../.records/enterprise-admin-e2e');

export const ensureEvidenceDir = async (subpath = ''): Promise<string> => {
  const dir = subpath ? path.join(EVIDENCE_ROOT, subpath) : EVIDENCE_ROOT;
  await mkdir(dir, { recursive: true });
  return dir;
};

/**
 * Capture a screenshot after a stable wait condition.
 * File names must not include emails, user ids, or tokens.
 */
export const captureEvidence = async (
  page: Page,
  name: string,
  options?: { fullPage?: boolean },
): Promise<string> => {
  const dir = await ensureEvidenceDir('screenshots');
  const safeName = name.replaceAll(/[^\w.-]+/g, '_');
  const filePath = path.join(dir, `${safeName}.png`);
  await page.screenshot({
    fullPage: options?.fullPage ?? false,
    path: filePath,
  });
  return filePath;
};

export type ThemeMode = 'light' | 'dark';
export type DeviceMode = 'desktop' | 'mobile';

/**
 * light/dark × desktop/mobile evidence matrix.
 * Theme is applied via document class / color-scheme (no product fixture).
 */
export const captureThemeDeviceMatrix = async (params: {
  browser: Browser;
  baseURL: string;
  cookies: Awaited<ReturnType<Page['context']>['cookies']> | undefined;
  prepare: (page: Page) => Promise<void>;
  slug: string;
}): Promise<string[]> => {
  const saved: string[] = [];
  const themes: ThemeMode[] = ['light', 'dark'];
  const devices: DeviceMode[] = ['desktop', 'mobile'];

  for (const theme of themes) {
    for (const device of devices) {
      const context = await params.browser.newContext({
        baseURL: params.baseURL,
        colorScheme: theme,
        viewport: VIEWPORTS[device],
      });
      if (params.cookies?.length) {
        await context.addCookies(params.cookies);
      }
      const page = await context.newPage();
      try {
        await page.addInitScript((mode: ThemeMode) => {
          document.documentElement.dataset.theme = mode;
          document.documentElement.style.colorScheme = mode;
          if (mode === 'dark') {
            document.documentElement.classList.add('dark');
          } else {
            document.documentElement.classList.remove('dark');
          }
        }, theme);
        await params.prepare(page);
        // Stable wait: body visible + network mostly idle (not DOM snapshot).
        await expect(page.locator('body')).toBeVisible();
        await page.waitForLoadState('domcontentloaded');
        const file = await captureEvidence(page, `${params.slug}-${theme}-${device}`);
        saved.push(file);
      } finally {
        await context.close();
      }
    }
  }
  return saved;
};
