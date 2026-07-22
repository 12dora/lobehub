// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAnalyticsConfig } from '../analytics';

beforeEach(() => {
  // 在每个测试用例之前,清除所有的 console.warn mock
  console.warn = vi.fn();
});

afterEach(() => {
  // 在每个测试用例之后,恢复所有的环境变量
  vi.resetModules();
});

describe('getAnalyticsConfig', () => {
  it('hard-disables every tracker regardless of environment variables (AIHub: telemetry removed)', () => {
    // Even with every tracker env var set, all trackers stay disabled and keys are cleared.
    process.env.PLAUSIBLE_DOMAIN = 'example.com';
    process.env.POSTHOG_KEY = 'posthog_key';
    process.env.UMAMI_WEBSITE_ID = 'umami_id';
    process.env.CLARITY_PROJECT_ID = 'clarity_id';
    process.env.ENABLE_VERCEL_ANALYTICS = '1';
    process.env.GOOGLE_ANALYTICS_MEASUREMENT_ID = 'ga_id';
    process.env.X_ADS_PIXEL_ID = 'tw-pixel_id';
    process.env.X_ADS_LOGIN_OR_SIGNUP_CLICKED_EVENT_ID = 'tw-pixel_id-login_or_signup_clicked';
    process.env.X_ADS_MAIN_PAGE_VIEW_EVENT_ID = 'tw-pixel_id-main_page_view';
    process.env.X_ADS_PURCHASE_EVENT_ID = 'tw-pixel_id-purchase_event_id';

    const config = getAnalyticsConfig();

    expect(config).toEqual({
      ENABLED_PLAUSIBLE_ANALYTICS: false,
      PLAUSIBLE_DOMAIN: undefined,
      PLAUSIBLE_SCRIPT_BASE_URL: 'https://plausible.io',
      ENABLED_POSTHOG_ANALYTICS: false,
      POSTHOG_KEY: undefined,
      POSTHOG_HOST: 'https://app.posthog.com',
      DEBUG_POSTHOG_ANALYTICS: false,
      ENABLED_UMAMI_ANALYTICS: false,
      UMAMI_SCRIPT_URL: 'https://analytics.umami.is/script.js',
      UMAMI_WEBSITE_ID: undefined,
      ENABLED_CLARITY_ANALYTICS: false,
      CLARITY_PROJECT_ID: undefined,
      ENABLE_VERCEL_ANALYTICS: false,
      DEBUG_VERCEL_ANALYTICS: false,
      ENABLE_GOOGLE_ANALYTICS: false,
      GOOGLE_ANALYTICS_MEASUREMENT_ID: undefined,
      ENABLED_X_ADS: false,
      X_ADS_PIXEL_ID: undefined,
      X_ADS_LOGIN_OR_SIGNUP_CLICKED_EVENT_ID: undefined,
      X_ADS_MAIN_PAGE_VIEW_EVENT_ID: undefined,
      X_ADS_PURCHASE_EVENT_ID: undefined,
    });
  });
});
