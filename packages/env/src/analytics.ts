import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const getAnalyticsConfig = () => {
  return createEnv({
    server: {
      ENABLED_PLAUSIBLE_ANALYTICS: z.boolean(),
      PLAUSIBLE_SCRIPT_BASE_URL: z.string(),
      PLAUSIBLE_DOMAIN: z.string().optional(),

      ENABLED_POSTHOG_ANALYTICS: z.boolean(),
      POSTHOG_KEY: z.string().optional(),
      POSTHOG_HOST: z.string(),
      DEBUG_POSTHOG_ANALYTICS: z.boolean(),

      ENABLED_UMAMI_ANALYTICS: z.boolean(),
      UMAMI_WEBSITE_ID: z.string().optional(),
      UMAMI_SCRIPT_URL: z.string(),

      ENABLED_CLARITY_ANALYTICS: z.boolean(),
      CLARITY_PROJECT_ID: z.string().optional(),

      ENABLE_VERCEL_ANALYTICS: z.boolean(),
      DEBUG_VERCEL_ANALYTICS: z.boolean(),

      ENABLE_GOOGLE_ANALYTICS: z.boolean(),
      GOOGLE_ANALYTICS_MEASUREMENT_ID: z.string().optional(),

      ENABLED_X_ADS: z.boolean(),
      X_ADS_PIXEL_ID: z.string().optional(),
      X_ADS_LOGIN_OR_SIGNUP_CLICKED_EVENT_ID: z.string().optional(),
      X_ADS_MAIN_PAGE_VIEW_EVENT_ID: z.string().optional(),
      X_ADS_PURCHASE_EVENT_ID: z.string().optional(),

      REACT_SCAN_MONITOR_API_KEY: z.string().optional(),
    },
    runtimeEnv: {
      // AIHub: built-in LobeHub telemetry is removed. Every third-party tracker is hard-disabled
      // and its key cleared regardless of environment variables, so no analytics/phone-home data
      // is ever emitted. Do not re-enable by setting the corresponding env vars — they are ignored.
      // Plausible Analytics
      ENABLED_PLAUSIBLE_ANALYTICS: false,
      PLAUSIBLE_DOMAIN: undefined,
      PLAUSIBLE_SCRIPT_BASE_URL: 'https://plausible.io',

      // Posthog Analytics
      ENABLED_POSTHOG_ANALYTICS: false,
      POSTHOG_KEY: undefined,
      POSTHOG_HOST: 'https://app.posthog.com',
      DEBUG_POSTHOG_ANALYTICS: false,

      // Umami Analytics
      ENABLED_UMAMI_ANALYTICS: false,
      UMAMI_SCRIPT_URL: 'https://analytics.umami.is/script.js',
      UMAMI_WEBSITE_ID: undefined,

      // Clarity Analytics
      ENABLED_CLARITY_ANALYTICS: false,
      CLARITY_PROJECT_ID: undefined,

      // Vercel Analytics
      ENABLE_VERCEL_ANALYTICS: false,
      DEBUG_VERCEL_ANALYTICS: false,

      // Google Analytics
      ENABLE_GOOGLE_ANALYTICS: false,
      GOOGLE_ANALYTICS_MEASUREMENT_ID: undefined,

      // X Ads
      ENABLED_X_ADS: false,
      X_ADS_PIXEL_ID: undefined,
      X_ADS_LOGIN_OR_SIGNUP_CLICKED_EVENT_ID: undefined,
      X_ADS_MAIN_PAGE_VIEW_EVENT_ID: undefined,
      X_ADS_PURCHASE_EVENT_ID: undefined,

      // React Scan Monitor
      REACT_SCAN_MONITOR_API_KEY: undefined,
    },
  });
};

export const analyticsEnv = getAnalyticsConfig();
