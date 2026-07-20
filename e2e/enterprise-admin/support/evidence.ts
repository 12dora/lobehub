import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Browser, Cookie, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { ADMIN_COPY, VIEWPORTS } from './selectors';

export const EVIDENCE_ROOT =
  process.env.E2E_ENTERPRISE_ADMIN_EVIDENCE_DIR ??
  path.resolve(__dirname, '../../../.records/enterprise-admin-e2e');

export const ensureEvidenceDir = async (subpath = ''): Promise<string> => {
  const dir = subpath ? path.join(EVIDENCE_ROOT, subpath) : EVIDENCE_ROOT;
  await mkdir(dir, { recursive: true });
  return dir;
};

const FORBIDDEN_LOADING_COPY = [
  'Checking admin access',
  'Checking admin access…',
  'Loading…',
  'Loading...',
  'Working…',
] as const;

/**
 * Assert page is on a stable admin surface — no access-check / loading shells.
 */
export const assertStableAdminSurface = async (
  page: Page,
  expected: {
    forbiddenTexts?: string[];
    heading: string | RegExp;
    requiredTexts?: string[];
  },
): Promise<void> => {
  await expect(page.getByRole('heading', { name: expected.heading })).toBeVisible({
    timeout: 90_000,
  });
  for (const text of FORBIDDEN_LOADING_COPY) {
    await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  }
  for (const text of expected.forbiddenTexts ?? []) {
    await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  }
  for (const text of expected.requiredTexts ?? []) {
    // Prefer heading role to avoid strict-mode collisions with nav/breadcrumb duplicates.
    const byHeading = page.getByRole('heading', { name: text });
    if ((await byHeading.count()) > 0) {
      await expect(byHeading.first()).toBeVisible({ timeout: 30_000 });
    } else {
      await expect(page.getByText(text, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    }
  }
};

/**
 * Capture screenshot only after stable content assertions (before + after).
 */
export const captureEvidence = async (
  page: Page,
  name: string,
  stable: {
    forbiddenTexts?: string[];
    heading: string | RegExp;
    requiredTexts?: string[];
  },
  options?: { fullPage?: boolean },
): Promise<string> => {
  await assertStableAdminSurface(page, stable);
  const dir = await ensureEvidenceDir('screenshots');
  const safeName = name.replaceAll(/[^\w.-]+/g, '_');
  const filePath = path.join(dir, `${safeName}.png`);
  await page.screenshot({
    fullPage: options?.fullPage ?? false,
    path: filePath,
  });
  await assertStableAdminSurface(page, stable);
  await assertEvidenceImageNotBlank(filePath);
  return filePath;
};

/** Minimal PNG structural check: non-trivial file size and PNG signature. */
export const assertEvidenceImageNotBlank = async (filePath: string): Promise<void> => {
  const buf = await readFile(filePath);
  if (buf.length < 8_000) {
    throw new Error(
      `evidence image too small (likely blank/loading): ${filePath} (${buf.length}b)`,
    );
  }
  const isPng =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d;
  if (!isPng) {
    throw new Error(`evidence image is not a PNG: ${filePath}`);
  }
};

export type ThemeMode = 'light' | 'dark';
export type DeviceMode = 'desktop' | 'mobile';

/**
 * light/dark × desktop/mobile evidence matrix.
 * prepare receives theme+device so desktop may only accept System and mobile only Desktop required.
 */
export const captureThemeDeviceMatrix = async (params: {
  browser: Browser;
  baseURL: string;
  cookies: Cookie[] | undefined;
  prepare: (page: Page, theme: ThemeMode, device: DeviceMode) => Promise<void>;
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
        await params.prepare(page, theme, device);
        await expect(page.locator('body')).toBeVisible();
        const expectedHeading =
          device === 'mobile' ? ADMIN_COPY.mobileUnsupportedTitle : ADMIN_COPY.systemTitle;
        const file = await captureEvidence(page, `${params.slug}-${theme}-${device}`, {
          forbiddenTexts: [
            ADMIN_COPY.accessDeniedTitle,
            ADMIN_COPY.featureOffTitle,
            device === 'mobile' ? ADMIN_COPY.systemTitle : ADMIN_COPY.mobileUnsupportedTitle,
          ],
          heading: expectedHeading,
        });
        saved.push(file);
      } finally {
        await context.close();
      }
    }
  }
  return saved;
};
