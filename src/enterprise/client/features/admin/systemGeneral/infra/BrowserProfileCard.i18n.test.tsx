// @vitest-environment happy-dom
import { MotionProvider } from '@lobehub/ui';
import { render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { motion } from 'motion/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { AdminBrowserProfileSummary } from '@/enterprise/client/services/adminSystem';
import defaultAdmin from '@/locales/default/admin';
import defaultCommon from '@/locales/default/common';

import { BrowserProfileCard } from './BrowserProfileCard';

/**
 * The sibling suite mocks translation, both UI packages and `InfraSettingsCard`, so it
 * cannot notice a missing locale key or a broken card contract. This one renders the REAL
 * card composition against the REAL `admin` bundle: a key the card asks for and the bundle
 * does not have would be rendered verbatim, and every assertion below would see it.
 */
const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    fallbackLng: 'en-US',
    interpolation: { escapeValue: false },
    lng: 'en-US',
    // `false` = a missing key renders as the key itself, which is exactly what we detect.
    parseMissingKeyHandler: undefined,
    resources: { 'en-US': { admin: defaultAdmin, common: defaultCommon } },
  });
});

const summary = (): AdminBrowserProfileSummary => ({
  arch: 'arm',
  chromeVersion: '150.0.7871.95',
  cores: 12,
  createdAt: new Date('2026-08-18T00:00:00.000Z'),
  impersonateProfile: 'chrome150',
  installationId: '123e4567-e89b-42d3-a456-426614174000',
  locale: 'en-US',
  memoryGiB: 36,
  platform: 'macOS',
  platformVersion: '15.6.1',
  revision: 3,
  screen: { dpr: 2, height: 982, width: 1512 },
  timezone: 'America/New_York',
  updatedAt: new Date('2026-08-18T01:00:00.000Z'),
});

describe('BrowserProfileCard with the real admin bundle', () => {
  it('renders every label and value through a key the bundle really has', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        {/* The app mounts MotionProvider globally; the real @lobehub/ui Button needs it. */}
        <MotionProvider motion={motion}>
          <BrowserProfileCard
            canOperate
            data={summary()}
            error={undefined}
            isLoading={false}
            onRegenerate={vi.fn()}
            onRetry={vi.fn()}
          />
        </MotionProvider>
      </I18nextProvider>,
    );

    const text = container.textContent ?? '';
    // A missing key renders as its own path — the one failure mode a mocked `t` can never show.
    expect(text).not.toContain('browserProfile.');
    // The real card composition, not a stub: title, notice, action and the field rows.
    expect(screen.getByText(defaultAdmin['browserProfile.title'])).toBeTruthy();
    expect(text).toContain(defaultAdmin['browserProfile.description']);
    expect(screen.getByText(defaultAdmin['browserProfile.actions.regenerate'])).toBeTruthy();
    expect(screen.getByText(defaultAdmin['browserProfile.fields.installationId'])).toBeTruthy();
    expect(screen.getByText('123e4567-e89b-42d3-a456-426614174000')).toBeTruthy();
    // Interpolated values resolve against the bundle's placeholders.
    expect(text).toContain('1512 × 982 @ 2×');
    expect(text).toContain('12 cores · 36 GiB');
    expect(text).not.toContain('{{');
  });
});
