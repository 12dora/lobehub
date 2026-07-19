import {
  BRANDING_EMAIL,
  BRANDING_LOGO_URL,
  BRANDING_NAME,
  BRANDING_URL,
  ORG_NAME,
} from './branding';

/** Immutable product fallback for the stable builtin inbox display identity. */
export const BUILT_IN_DEFAULT_AGENT_DISPLAY_NAME = 'Lobe AI';

/** Immutable fallback for request-time Runtime Branding consumers. */
export const BUILT_IN_RUNTIME_BRANDING = {
  defaultAgentDisplayName: BUILT_IN_DEFAULT_AGENT_DISPLAY_NAME,
  emailFrom: BRANDING_EMAIL.support,
  emailSenderName: BRANDING_NAME,
  faviconUrl: null,
  homeUrl: null,
  iconUrl: null,
  legalName: ORG_NAME,
  logoUrl: BRANDING_LOGO_URL || null,
  name: BRANDING_NAME,
  ogImageUrl: null,
  pageTitleTemplate: `%s · ${BRANDING_NAME}`,
  privacyUrl: BRANDING_URL.privacy ?? null,
  publishedRevision: null,
  shortName: BRANDING_NAME,
  supportUrl: BRANDING_URL.support ?? BRANDING_URL.help ?? null,
  termsUrl: BRANDING_URL.terms ?? null,
} as const;
