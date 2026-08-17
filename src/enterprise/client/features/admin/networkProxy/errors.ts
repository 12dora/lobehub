import { NETWORK_PROXY_ENGINE_ISSUE_CODES } from '@/const/platform/networkProxy';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

export const NETWORK_PROXY_GENERIC_ERROR_KEY = 'networkProxy.errors.generic';

/**
 * The settings write committed, but the instance that answered could not carry it out
 * (design §3.3: install / restart / node selection are local actions on top of a desired-state
 * write). Reported separately because the configuration *did* change — retrying is safe, and
 * pretending the whole operation failed would be as wrong as pretending it succeeded.
 */
export class NetworkProxyLocalError extends Error {
  /** An engine issue code (contract I2), never a raw server message. */
  readonly issueCode: string | null;

  constructor(issueCode: string | null) {
    super(issueCode ?? 'NETWORK_PROXY_LOCAL_FAILED');
    this.issueCode = issueCode;
    this.name = 'NetworkProxyLocalError';
  }
}

const ISSUE_CODES: readonly string[] = NETWORK_PROXY_ENGINE_ISSUE_CODES;

/**
 * `admin`-namespace key for one engine issue code.
 *
 * The engine reports a code, never prose: anything the server could not classify — and anything
 * this build does not know yet — reads as the generic "check the logs" line rather than leaking
 * a raw exception into the panel.
 */
export const networkProxyIssueKey = (code: string | null | undefined): string =>
  code && ISSUE_CODES.includes(code)
    ? `networkProxy.engineIssue.${code}`
    : 'networkProxy.engineIssue.unknown';

/** Losing a CAS race is a normal outcome here — two admins on one settings row. */
export const isRevisionConflict = (error: unknown): boolean =>
  mapEnterpriseError(error)?.code === 'PLATFORM_REVISION_CONFLICT';

/**
 * An `admin`-namespace i18n key for any network-proxy failure.
 *
 * Enterprise codes have their own copy (`enterprise.error.<CODE>`); anything else falls back to a
 * message that still says what to do, because a raw server string may carry a proxy URL.
 */
export const networkProxyErrorKey = (error: unknown): string =>
  error instanceof NetworkProxyLocalError
    ? 'networkProxy.errors.localFailed'
    : (mapEnterpriseError(error)?.i18nKey ?? NETWORK_PROXY_GENERIC_ERROR_KEY);
