/**
 * Locale-independent sentinels for adapter-local preconditions.
 * Do not put translated copy in Error.message and then string-match it (breaks under zh-CN).
 */
export const LOCAL_ERROR = {
  CONNECTOR_HTTP_ONLY: 'CONNECTOR_HTTP_ONLY',
  CONNECTOR_IDENTIFIER_INVALID: 'CONNECTOR_IDENTIFIER_INVALID',
  CONNECTOR_OAUTH_VIA_ADVANCED: 'CONNECTOR_OAUTH_VIA_ADVANCED',
  CREATE_DISCOVERY_FAILED: 'CONNECTOR_CREATE_DISCOVERY_FAILED',
  CREATE_INCOMPLETE: 'CONNECTOR_CREATE_INCOMPLETE',
  PERMISSION: 'PLATFORM_PERMISSION_DENIED',
  SKILL_FORM_INVALID: 'SKILL_VERSION_FORM_INVALID',
  SKILL_RESOURCES_TRUNCATED: 'SKILL_IMPORT_RESOURCES_TRUNCATED',
} as const;

/** Local guard / parse failures that never reach a toasting service wrapper. */
export const isLocalAdapterError = (err: unknown) =>
  err instanceof Error &&
  (err.message === LOCAL_ERROR.PERMISSION ||
    err.message === LOCAL_ERROR.CONNECTOR_HTTP_ONLY ||
    err.message === LOCAL_ERROR.CONNECTOR_OAUTH_VIA_ADVANCED ||
    err.message === LOCAL_ERROR.CONNECTOR_IDENTIFIER_INVALID ||
    err.message === LOCAL_ERROR.SKILL_FORM_INVALID ||
    err.message === LOCAL_ERROR.SKILL_RESOURCES_TRUNCATED);

export const isPartialCreateMarker = (err: unknown) =>
  err instanceof Error &&
  (err.message === LOCAL_ERROR.CREATE_INCOMPLETE ||
    err.message === LOCAL_ERROR.CREATE_DISCOVERY_FAILED);
