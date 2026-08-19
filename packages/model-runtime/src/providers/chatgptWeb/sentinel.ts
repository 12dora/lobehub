import type { RuntimeBrowserDeviceProfile } from '../../browserProfile';
import { DEFAULT_BROWSER_DEVICE_PROFILE } from '../../browserProfile';
import { DEFAULT_POW_SCRIPT, OAI_CLIENT_VERSION } from './constants';
import { callerAbortReason, ChatGPTWebError, isChatGPTWebError } from './errors';
import {
  buildLegacyRequirementsToken,
  buildPowConfig,
  parsePowResources,
  type PowResources,
  solveProofToken,
} from './pow';
import { solveTurnstileToken } from './turnstile';
import type { ChatRequirements } from './types';

export interface SentinelPrepareResponse {
  arkose?: { required?: boolean };
  prepare_token?: string;
  proofofwork?: { difficulty?: string; required?: boolean; seed?: string };
  turnstile?: { dx?: string; required?: boolean };
}

export interface SentinelFinalizeResponse {
  /**
   * Seconds until the requirements token expires. Captured 2026-08-19 as `540`.
   */
  expire_after?: number;
  /** Unix-seconds deadline for the requirements token. */
  expire_at?: number;
  so_token?: string;
  token?: string;
}

/**
 * HAR-exact finalize body (2026-08-19 `chatgpt.com.har`). The previous aliases
 * `proof_token` / `turnstile_token` are not what Chrome sends.
 */
export interface SentinelFinalizeBody {
  prepare_token: string;
  proofofwork: string;
  turnstile: string;
}

/** Observed `expire_after` on a paid-session finalize (seconds). */
export const SENTINEL_BUNDLE_TTL_SEC = 540;

export const buildSentinelFinalizeBody = (
  prepareToken: string | undefined,
  challenges: { proofToken: string; turnstileToken: string },
): SentinelFinalizeBody => ({
  prepare_token: prepareToken ?? '',
  proofofwork: challenges.proofToken,
  turnstile: challenges.turnstileToken,
});

/**
 * Absolute expiry for a minted bundle. Prefer the upstream `expire_at` unix
 * timestamp; fall back to `expire_after` seconds; last resort is the captured
 * 540s TTL. Never invent a tighter window than the HAR evidence.
 */
export const resolveSentinelBundleExpiryMs = (
  finalize: SentinelFinalizeResponse,
  nowMs = Date.now(),
): number => {
  if (
    typeof finalize.expire_at === 'number' &&
    Number.isFinite(finalize.expire_at) &&
    finalize.expire_at > 0
  )
    return finalize.expire_at * 1000;

  const after =
    typeof finalize.expire_after === 'number' &&
    Number.isFinite(finalize.expire_after) &&
    finalize.expire_after > 0
      ? finalize.expire_after
      : SENTINEL_BUNDLE_TTL_SEC;
  return nowMs + after * 1000;
};

/**
 * Bootstrap HTML → pow resources. The bootstrap is the request most likely to be
 * challenged by Cloudflare; when it fails we fall back to the SDK URL, which the
 * upstream accepts.
 */
export const resolvePowResources = (html: string | undefined): PowResources => {
  if (!html) return { dataBuild: OAI_CLIENT_VERSION, scriptSources: [DEFAULT_POW_SCRIPT] };
  return parsePowResources(html);
};

/** `<html data-build="prod-…">` — the live `OAI-Client-Version`. */
const CLIENT_VERSION_RE = /data-build="(prod-[\w.-]+)"/;
/**
 * `build_number` inside the embedded payloads. The homepage has shipped this
 * JSON both raw and escaped through multiple serialization layers, so match
 * bounded non-digits between the stable key and its numeric value rather than
 * assuming exactly one `\"` layer.
 */
const CLIENT_BUILD_NUMBER_RE = /build_number\D{0,32}(\d{5,})/i;

export interface ClientBuildInfo {
  buildNumber?: string;
  clientVersion?: string;
}

/**
 * Scrape the live `OAI-Client-Version` / `OAI-Client-Build-Number` out of the
 * bootstrap HTML. Both are optional: an unparseable (or unreachable) bootstrap
 * leaves the caller on the pinned constants, which the backend still accepts.
 */
export const parseClientBuildInfo = (html: string | undefined): ClientBuildInfo => {
  if (!html) return {};
  return {
    buildNumber: CLIENT_BUILD_NUMBER_RE.exec(html)?.[1],
    clientVersion: CLIENT_VERSION_RE.exec(html)?.[1],
  };
};

/** The `p` token posted to `…/chat-requirements/prepare`. */
export const buildRequirementsToken = (
  resources: PowResources,
  userAgent: string,
  browserProfile: RuntimeBrowserDeviceProfile = DEFAULT_BROWSER_DEVICE_PROFILE,
): string =>
  buildLegacyRequirementsToken({
    browserProfile,
    dataBuild: resources.dataBuild,
    scriptSources: resources.scriptSources,
    userAgent,
  });

export interface SolveChallengesOptions {
  browserProfile?: RuntimeBrowserDeviceProfile;
  powLimit?: number;
  prepare: SentinelPrepareResponse;
  requirementsToken: string;
  resources: PowResources;
  signal?: AbortSignal;
  userAgent: string;
}

/**
 * Solve whatever the prepare step asked for. Arkose is not implementable
 * client-side — surface it as its own error kind so callers can tell the user to
 * retry from a real browser session.
 */
export const solveSentinelChallenges = async ({
  browserProfile = DEFAULT_BROWSER_DEVICE_PROFILE,
  powLimit,
  prepare,
  requirementsToken,
  resources,
  signal,
  userAgent,
}: SolveChallengesOptions): Promise<{ proofToken: string; turnstileToken: string }> => {
  if (prepare.arkose?.required === true)
    throw new ChatGPTWebError(
      'arkose',
      'chatgpt.com asked for an Arkose token, which this client cannot produce',
    );

  let proofToken = '';
  if (prepare.proofofwork?.required && prepare.proofofwork.seed && prepare.proofofwork.difficulty) {
    const { difficulty, seed } = prepare.proofofwork;
    const solve = () =>
      solveProofToken({
        // a fresh randomized fingerprint each attempt: the iteration cap is a
        // property of THIS config, so retrying with the same one is pointless
        config: buildPowConfig({
          browserProfile,
          dataBuild: resources.dataBuild,
          scriptSources: resources.scriptSources,
          userAgent,
        }),
        difficulty,
        limit: powLimit,
        seed,
        signal,
      });

    try {
      proofToken = await solve();
    } catch (error) {
      // caller cancellation wins over any retry
      const callerReason = callerAbortReason(signal);
      if (callerReason !== undefined) throw callerReason;
      if (!isChatGPTWebError(error) || error.kind !== 'pow') throw error;
      try {
        proofToken = await solve();
      } catch (retryError) {
        // `solveProofToken` maps a signal abort onto `kind: 'timeout'`, so the
        // SECOND attempt needs the same guard: the user pressing stop must not
        // be reported as a provider timeout.
        const retryReason = callerAbortReason(signal);
        if (retryReason !== undefined) throw retryReason;
        throw retryError;
      }
    }
  }

  let turnstileToken = '';
  if (prepare.turnstile?.required && prepare.turnstile.dx)
    turnstileToken = solveTurnstileToken(prepare.turnstile.dx, requirementsToken) ?? '';

  return { proofToken, turnstileToken };
};

export const toChatRequirements = (
  finalize: SentinelFinalizeResponse,
  challenges: { proofToken: string; turnstileToken: string },
): ChatRequirements => {
  if (!finalize.token)
    // deliberately no `body`: the finalize payload is nothing but tokens
    // (`so_token`, `token`), and an error object is routinely serialized whole
    throw new ChatGPTWebError('upstream', 'sentinel finalize returned an empty requirements token');

  return {
    proofToken: challenges.proofToken,
    soToken: finalize.so_token ?? '',
    token: finalize.token,
    turnstileToken: challenges.turnstileToken,
  };
};
