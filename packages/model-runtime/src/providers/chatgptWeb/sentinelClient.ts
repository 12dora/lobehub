import createDebug from 'debug';

import { abortableSleep } from './boundedBody';
import type { ChatGPTWebClientInit } from './clientTypes';
import { CHATGPT_BASE_URL, PATHS, TIMEOUTS } from './constants';
import { callerAbortReason, describeThrownValue, isChatGPTWebError } from './errors';
import { buildBootstrapHeaders } from './headers';
import { ChatGPTWebHttp } from './http';
import type { PowResources } from './pow';
import type { SentinelFinalizeResponse, SentinelPrepareResponse } from './sentinel';
import {
  buildRequirementsToken,
  buildSentinelFinalizeBody,
  parseClientBuildInfo,
  resolvePowResources,
  resolveSentinelBundleExpiryMs,
  solveSentinelChallenges,
  toChatRequirements,
} from './sentinel';
import type {
  AcquiredSentinelBundle,
  MintedSentinelBundle,
  SentinelBundleBinding,
  SentinelBundlePool,
} from './sentinelBundlePool';
import { deriveSentinelContextKey, getSharedSentinelBundlePool } from './sentinelBundlePool';
import {
  startChatGPTWebSentinelKeepWarm,
  stopChatGPTWebSentinelKeepWarm,
} from './sentinelKeepWarm';
import { getDurationMs, timing } from './timing';
import type { ChatRequirements } from './types';

const log = createDebug('lobe-chatgptweb:client');

export class ChatGPTWebSentinelClient extends ChatGPTWebHttp {
  private powResources?: PowResources;
  private readonly sentinelPool: SentinelBundlePool;

  constructor(options: ChatGPTWebClientInit) {
    super(options);
    this.sentinelPool = options.sentinelBundlePool ?? getSharedSentinelBundlePool();
  }

  // ------------------------------------------------------------------ account

  async getMe(signal?: AbortSignal): Promise<{ email?: string; id?: string; raw: unknown }> {
    const raw = await this.requestJson<Record<string, any>>({
      context: 'me',
      path: PATHS.me,
      signal,
      timeoutMs: 20_000,
    });
    return { email: raw?.email, id: raw?.id, raw };
  }

  async getAccountsCheck(signal?: AbortSignal): Promise<{
    accountId?: string;
    hasActiveSubscription?: boolean;
    planType: string;
    raw: unknown;
  }> {
    const raw = await this.requestJson<Record<string, any>>({
      context: 'accounts_check',
      path: PATHS.accountsCheck,
      // the target path/route headers deliberately exclude the query string
      query: `?timezone_offset_min=${this.timezoneOffsetMin}`,
      signal,
    });
    const account = raw?.accounts?.default?.account;
    return {
      accountId: account?.account_id,
      hasActiveSubscription: raw?.accounts?.default?.entitlement?.has_active_subscription,
      planType: account?.plan_type ?? 'free',
      raw,
    };
  }

  async getConversationInit(signal?: AbortSignal): Promise<{
    defaultModelSlug?: string;
    imageQuotaRemaining?: number;
    imageQuotaResetAfter?: string;
    limitsProgress: unknown[];
  }> {
    const raw = await this.requestJson<Record<string, any>>({
      ...this.jsonBody({
        conversation_id: null,
        gizmo_id: null,
        requested_default_model: null,
        timezone_offset_min: this.timezoneOffsetMin,
      }),
      context: 'conversation_init',
      path: PATHS.conversationInit,
      signal,
    });

    const limitsProgress: any[] = Array.isArray(raw?.limits_progress) ? raw.limits_progress : [];
    const imageGen = limitsProgress.find((item) => item?.feature_name === 'image_gen');
    return {
      defaultModelSlug: raw?.default_model_slug,
      imageQuotaRemaining:
        imageGen?.remaining === undefined ? undefined : Number(imageGen.remaining) || 0,
      imageQuotaResetAfter: imageGen?.reset_after ? String(imageGen.reset_after) : undefined,
      limitsProgress,
    };
  }

  async listModels(
    signal?: AbortSignal,
  ): Promise<
    { description?: string; maxTokens?: number; raw: unknown; slug: string; title?: string }[]
  > {
    const raw = await this.requestJson<Record<string, any>>({
      context: 'models',
      path: PATHS.models,
      query: '?history_and_training_disabled=false',
      signal,
    });
    const models: any[] = Array.isArray(raw?.models) ? raw.models : [];
    return models
      .filter((model) => typeof model?.slug === 'string' && model.slug)
      .map((model) => ({
        description: model.description,
        maxTokens: model.max_tokens,
        raw: model,
        slug: model.slug,
        title: model.title,
      }));
  }

  // ----------------------------------------------------------------- sentinel

  /**
   * The bootstrap HTML is the request most likely to be Cloudflare-challenged;
   * on failure we fall back to the default SDK script, which the upstream
   * accepts. Cached on the Browser Session Context (survives per-call client
   * reconstruction) and, failing that, on this instance.
   */
  private async bootstrapPowResources(signal?: AbortSignal): Promise<PowResources> {
    if (this.powResources) return this.powResources;
    const cached = this.sessionContext?.getBootstrap();
    if (cached?.powResources) {
      if (cached.clientVersion) this.fingerprint.clientVersion = cached.clientVersion;
      if (cached.clientBuildNumber) this.fingerprint.clientBuildNumber = cached.clientBuildNumber;
      this.powResources = cached.powResources;
      return this.powResources;
    }

    let html: string | undefined;
    try {
      const managed = await this.rawFetch(
        `${CHATGPT_BASE_URL}/`,
        { headers: buildBootstrapHeaders(this.fingerprint) },
        { context: 'bootstrap', signal, timeoutMs: TIMEOUTS.bootstrap },
      );
      try {
        // the deadline stays armed until the HTML is fully read
        if (managed.response.ok) html = await managed.response.text();
        else
          log(
            'bootstrap returned %d, falling back to the default pow script',
            managed.response.status,
          );
      } finally {
        managed.release();
      }
    } catch (error) {
      // a caller-initiated stop is not a "bootstrap failure" to shrug off
      const callerReason = callerAbortReason(signal);
      if (callerReason !== undefined) throw callerReason;
      log('bootstrap failed (%s), falling back to the default pow script', String(error));
    }

    /**
     * An expired/missing web session gets the lightweight `/unauth-mweb/` shell.
     * Its build and asset graph are NOT the authenticated ChatGPT client this
     * runtime impersonates, so mixing them into the session headers / Sentinel
     * proof creates an impossible hybrid. Keep the pinned authenticated build
     * pair and SDK when that shell is all the bootstrap returned.
     */
    const unauthenticatedShell = Boolean(html?.includes('/unauth-mweb/'));
    const authenticatedHtml = unauthenticatedShell ? undefined : html;
    if (html && !authenticatedHtml)
      log('bootstrap returned the unauthenticated mweb shell; using pinned web-client markers');

    // The bootstrap also carries the live build markers the session headers
    // advertise; keep the pinned constants when it could not be read.
    const { buildNumber, clientVersion } = parseClientBuildInfo(authenticatedHtml);
    if (clientVersion) this.fingerprint.clientVersion = clientVersion;
    if (buildNumber) this.fingerprint.clientBuildNumber = buildNumber;

    this.powResources = resolvePowResources(authenticatedHtml);
    // An unauthenticated `/unauth-mweb/` shell is not a valid cache entry: the
    // next reconstructed client (after a session cookie is seeded) must retry
    // authenticated bootstrap instead of trusting pinned fallbacks forever.
    if (!unauthenticatedShell) {
      this.sessionContext?.setBootstrap({
        ...(this.fingerprint.clientBuildNumber
          ? { clientBuildNumber: this.fingerprint.clientBuildNumber }
          : {}),
        ...(this.fingerprint.clientVersion
          ? { clientVersion: this.fingerprint.clientVersion }
          : {}),
        powResources: this.powResources,
      });
    }
    return this.powResources;
  }

  /**
   * Mint a fresh Sentinel bundle from upstream. Does not touch the pool — image
   * generation and tests still call this for a blocking handshake. Conversation
   * turns should go through {@link acquireSentinelBundle} instead.
   */
  async getChatRequirements({
    onProgress,
    powLimit,
    signal,
  }: {
    onProgress?: (stage: 'bootstrap' | 'prepare' | 'solve' | 'finalize') => void;
    powLimit?: number;
    signal?: AbortSignal;
  } = {}): Promise<ChatRequirements> {
    return (await this.mintChatRequirements({ onProgress, powLimit, signal })).requirements;
  }

  /**
   * Take one ready bundle for this context. Cold contexts mint synchronously;
   * a warm pool returns immediately without a same-turn handshake.
   */
  async acquireSentinelBundle({
    contextKey,
    onProgress,
    powLimit,
    signal,
  }: {
    contextKey?: string;
    onProgress?: (stage: 'bootstrap' | 'prepare' | 'solve' | 'finalize') => void;
    powLimit?: number;
    signal?: AbortSignal;
  } = {}): Promise<AcquiredSentinelBundle> {
    const binding = this.sentinelBinding(contextKey);
    const startedAt = Date.now();
    let minted = false;
    const acquired = await this.sentinelPool.acquire(
      binding,
      (mintSignal) => {
        minted = true;
        return this.mintChatRequirements({ onProgress, powLimit, signal: mintSignal });
      },
      signal,
    );
    timing(
      'sentinel acquire source=%s durationMs=%d',
      minted ? 'cold' : 'warm',
      getDurationMs(startedAt),
    );
    return acquired;
  }

  /**
   * Fire-and-forget keep-warm for this context. Never throws into bind / chat.
   */
  keepSentinelWarm(contextKey?: string): void {
    try {
      startChatGPTWebSentinelKeepWarm(this.sentinelBinding(contextKey), (mintSignal) =>
        this.mintChatRequirements({ signal: mintSignal }),
      );
    } catch (error) {
      log('keepSentinelWarm failed: %s', describeThrownValue(error));
    }
  }

  /**
   * Park one ready bundle without consuming it. Call on context init/reconnect
   * so the first turn is not waiting on a background warm that never started.
   */
  async warmSentinelBundle({
    contextKey,
    signal,
  }: {
    contextKey?: string;
    signal?: AbortSignal;
  } = {}): Promise<void> {
    await this.sentinelPool.warm(
      this.sentinelBinding(contextKey),
      (mintSignal) => this.mintChatRequirements({ signal: mintSignal }),
      signal,
    );
  }

  /**
   * Start the next handshake in the background. Fire-and-forget: a failure
   * never rejects the current turn; the next acquire retries.
   *
   * Do not pass the turn abort signal — stopping a stream must not cancel the
   * next bundle.
   */
  replenishSentinelBundle({ contextKey }: { contextKey?: string } = {}): void {
    this.sentinelPool.replenish(this.sentinelBinding(contextKey), (mintSignal) =>
      this.mintChatRequirements({ signal: mintSignal }),
    );
  }

  /** Drop parked bundles when the context reconnects or the device/profile changes. */
  invalidateSentinelBundles(contextKey?: string): void {
    const key = this.resolveContextKey(contextKey);
    this.sentinelPool.invalidate(key);
    stopChatGPTWebSentinelKeepWarm(key);
  }

  private resolveContextKey(contextKey?: string): string {
    return (
      contextKey ??
      deriveSentinelContextKey({
        deviceId: this.deviceId,
        profileId: this.browserProfile.id,
        sessionId: this.sessionId,
      })
    );
  }

  private sentinelBinding(contextKey?: string): SentinelBundleBinding {
    return {
      clientBuildNumber: this.fingerprint.clientBuildNumber,
      clientVersion: this.fingerprint.clientVersion,
      contextKey: this.resolveContextKey(contextKey),
      deviceId: this.deviceId,
      profileId: this.browserProfile.id,
      sessionId: this.sessionId,
    };
  }

  private async mintChatRequirements({
    onProgress,
    powLimit,
    signal,
  }: {
    onProgress?: (stage: 'bootstrap' | 'prepare' | 'solve' | 'finalize') => void;
    powLimit?: number;
    signal?: AbortSignal;
  } = {}): Promise<MintedSentinelBundle> {
    const mark = async <T>(
      stage: 'bootstrap' | 'prepare' | 'solve' | 'finalize',
      work: () => Promise<T>,
    ): Promise<T> => {
      onProgress?.(stage);
      const startedAt = Date.now();
      try {
        return await work();
      } finally {
        timing('sentinel %s durationMs=%d', stage, getDurationMs(startedAt));
      }
    };

    const resources = await mark('bootstrap', () => this.bootstrapPowResources(signal));
    const userAgent = this.userAgent;
    const requirementsToken = buildRequirementsToken(resources, userAgent, this.browserProfile);

    const prepare = await mark('prepare', () =>
      this.retryOnCloudflare(
        () =>
          this.requestJson<SentinelPrepareResponse>({
            ...this.jsonBody({ p: requirementsToken }),
            context: 'sentinel_prepare',
            path: `${PATHS.sentinelRequirements}/prepare`,
            signal,
            timeoutMs: TIMEOUTS.sentinel,
          }),
        signal,
      ),
    );

    const challenges = await mark('solve', () =>
      solveSentinelChallenges({
        powLimit,
        prepare,
        browserProfile: this.browserProfile,
        requirementsToken,
        resources,
        signal,
        userAgent,
      }),
    );

    const finalize = await mark('finalize', () =>
      this.retryOnCloudflare(
        () =>
          this.requestJson<SentinelFinalizeResponse>({
            ...this.jsonBody(buildSentinelFinalizeBody(prepare.prepare_token, challenges)),
            context: 'sentinel_finalize',
            path: `${PATHS.sentinelRequirements}/finalize`,
            signal,
            timeoutMs: TIMEOUTS.sentinel,
          }),
        signal,
      ),
    );

    return {
      clientBuildNumber: this.fingerprint.clientBuildNumber,
      clientVersion: this.fingerprint.clientVersion,
      expiresAtMs: resolveSentinelBundleExpiryMs(finalize),
      requirements: toChatRequirements(finalize, challenges),
    };
  }

  /**
   * A Cloudflare interstitial on the sentinel handshake is usually transient —
   * one immediate re-issue clears it. Retried exactly once, with a small jitter
   * so a burst of clients does not resynchronise, and never against a caller
   * that has already cancelled.
   */
  private async retryOnCloudflare<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const callerReason = callerAbortReason(signal);
      if (callerReason !== undefined) throw callerReason;
      if (!isChatGPTWebError(error) || error.kind !== 'cloudflare') throw error;
      log('sentinel call was Cloudflare-challenged, retrying once');
      await abortableSleep(300 + Math.floor(Math.random() * 500), signal);
      return run();
    }
  }
}
