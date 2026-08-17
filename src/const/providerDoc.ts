/**
 * Builtin providers this deployment added on its own, so `BASE_PROVIDER_DOC_URL/<id>` on the
 * upstream site is a 404. The provider header's `?` link is suppressed for them: a help link
 * that lands on "page not found" costs more trust than no help link at all.
 */
export const PROVIDERS_WITHOUT_UPSTREAM_DOC: ReadonlySet<string> = new Set([
  'chatgptweb',
  'grok',
  'cursor',
]);
