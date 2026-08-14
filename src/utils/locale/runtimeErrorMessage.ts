import { getErrorCodeSpec } from '@lobechat/model-runtime';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

/**
 * Loose `t` shape that accepts any key / vars — the type-safe key inference in
 * `i18next.CustomTypeOptions` doesn't help here because we look up dynamically.
 */
type LooseT = (key: string, vars?: Record<string, unknown>) => string;

/**
 * Platform (enterprise) error codes that reach a CHAT surface and own chat-facing copy under
 * `error:response.<CODE>`.
 *
 * They are not `AgentRuntimeErrorType` members and not `ChatErrorType` members, so neither
 * automatic registry recognises them — yet the server can end a conversation turn with one
 * (e.g. an admin hard-deletes the provider mid-conversation). Register a code here ONLY once
 * its `error:response.<CODE>` copy exists in default + en-US + zh-CN; anything unregistered
 * correctly falls through to the trace-id report UI rather than rendering a raw key.
 *
 * The admin console keeps its own, differently-worded `admin:enterprise.error.<CODE>` label —
 * that one addresses an operator, this one addresses the person mid-chat.
 */
export const PLATFORM_LOCALIZED_ERROR_TYPES = new Set<string>([
  PLATFORM_ERROR_CODES.PLATFORM_AI_PROVIDER_DISABLED,
]);

/** True when `getRuntimeErrorMessage` resolves dedicated chat copy for a platform error code. */
export const isPlatformLocalizedErrorType = (code: string): boolean =>
  PLATFORM_LOCALIZED_ERROR_TYPES.has(code);

/**
 * Resolve the localized message for an error type, routing between the new
 * `modelRuntime` namespace (one key per `AgentRuntimeErrorType`) and the legacy
 * `error.response.<X>` map.
 *
 * - If `code` is a known runtime code (present in `ERROR_CODE_SPECS`), the
 *   message lives under `modelRuntime:<code>`.
 * - Otherwise (HTTP status code, Plugin*, Cloud-only ChatErrorType, etc.) it
 *   stays in the legacy `error.response.<X>` location.
 *
 * The caller should pre-load both namespaces:
 * `useTranslation(['error', 'modelRuntime'])`.
 */
export const getRuntimeErrorMessage = (
  t: unknown,
  code: string | number | undefined,
  vars?: Record<string, unknown>,
): string => {
  if (code === undefined || code === null || code === '') return '';
  const key =
    typeof code === 'string' && getErrorCodeSpec(code)
      ? `modelRuntime:${code}`
      : `response.${code}`;
  return (t as LooseT)(key, vars);
};
