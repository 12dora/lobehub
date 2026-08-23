import { randomUUID } from 'node:crypto';

import { PlatformAiCatalogModel, type PlatformAiModelDraftView } from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { PlatformAiProviderItem } from '@/database/schemas/platform';
import { resolvePlatformBrowserProfile } from '@/server/modules/ModelRuntime';

import { PlatformAuditService } from '../platformAudit';
import { AiCatalogAdminServiceDraftOps } from './adminService.draft';
import type {
  AiCatalogConnectionTestService,
  AiConnectionTestResult,
} from './connectionTestService';
import { aiConnectionFailureCode } from './connectionTestService';
import { normalizeAiCatalogExecutionCredentials } from './credentialAdapter';
import { AiCatalogNotFoundError, AiCatalogValidationError } from './errors';
import { aiCatalogDraftToken } from './shared';
import {
  isOAuthAuthorizationExpiredError,
  isSharedOAuthRefreshConsumedError,
  refreshSharedOAuthVault,
} from './sharedOAuthRefresh';

type ConnectionTestSnapshot = {
  attemptId: string;
  model: PlatformAiModelDraftView | undefined;
  provider: PlatformAiProviderItem;
  requestedModel: string | null;
};

type ConnectionTestFinalized =
  { applied: true; result: AiConnectionTestResult } | { applied: false };

export abstract class AiCatalogAdminServiceConnectionTestOps extends AiCatalogAdminServiceDraftOps {
  protected abstract readonly connectionTests: AiCatalogConnectionTestService;

  testProvider = async (
    actorUserId: string,
    input: { id: string; model?: string; reason: string },
  ): Promise<AiConnectionTestResult> => {
    const reason = await this.sanitizeReason(input.reason, input.id);
    let finalized: ConnectionTestFinalized | undefined;
    try {
      const snapshot = await this.beginConnectionTestAttempt(input.id, input.model);
      const configurationIssue = resolveCheckModelIssue(snapshot);

      let result: AiConnectionTestResult;
      if (configurationIssue) {
        result = {
          errorCategory: 'invalid_config',
          latencyMs: 0,
          sanitizedMessage: configurationIssue,
          status: 'failure',
          testedAt: new Date(),
        };
      } else {
        result = await this.runConnectionProbe(snapshot);
      }
      // CAS finalization + success/failure audit must be one transaction so a discarded
      // (superseded) probe never audits or returns as authoritative.
      finalized = await this.finalizeConnectionTest(
        input.id,
        snapshot.attemptId,
        result,
        actorUserId,
        reason,
      );
    } catch (error) {
      // Real operational failures only. Superseded CAS no-ops are handled below and must
      // not write a misleading FAILURE audit for a discarded probe.
      await this.appendFailureAudit({
        action: 'admin.aiProviders.test',
        actorUserId,
        reason,
        targetId: input.id,
      });
      throw error;
    }

    if (finalized?.applied) return finalized.result;

    return this.readSupersededConnectionTestResult(input.id);
  };

  private beginConnectionTestAttempt = async (
    id: string,
    requestedModelOverride?: string,
  ): Promise<ConnectionTestSnapshot> => {
    return this.db.transaction(async (tx) => {
      const repository = new PlatformAiCatalogRepository(tx);
      const provider = await repository.lockProvider(id);
      if (!provider) throw new AiCatalogNotFoundError();
      const draft = await new PlatformAiCatalogModel(tx).getProvider(id);
      if (!draft) throw new AiCatalogNotFoundError();
      const attemptId = randomUUID();
      const testedAt = new Date();
      const testedDraftToken = aiCatalogDraftToken(draft);
      await repository.updateProvider(id, {
        connectionTestAttemptId: attemptId,
        connectionTestErrorCategory: null,
        connectionTestLatencyMs: null,
        connectionTestSanitizedMessage: 'Connection test in progress',
        connectionTestStatus: 'pending',
        connectionTestedAt: testedAt,
        connectionTestedDraftToken: testedDraftToken,
        connectionTestedRevision: draft.revision,
      });
      // An explicit override lets the operator probe the model selected in the UI without
      // persisting it first; otherwise the provider's stored check model is used.
      const requestedModel = requestedModelOverride ?? provider.checkModel ?? null;
      const model = requestedModel
        ? draft.models.find((item) => item.modelKey === requestedModel)
        : undefined;
      return { attemptId, model, provider, requestedModel };
    });
  };

  private async runConnectionProbe(
    snapshot: ConnectionTestSnapshot,
  ): Promise<AiConnectionTestResult> {
    try {
      const keyVaults = snapshot.provider.encryptedKeyVaults
        ? await this.secrets.decrypt(snapshot.provider.encryptedKeyVaults)
        : {};
      // Probe with the SAME credential a chat would use. Shared rotating-refresh vaults
      // (chatgpt/supergrok) rotate lazily on execution, so without this the admin check
      // could fail on an expired token that chat would have silently renewed. Rotation
      // happens in place at the stable fingerprint, so it is the identical secret version
      // the published revision pins.
      //
      // Isolated from the probe on purpose: refresh is PROACTIVE (it fires ~2min before
      // expiry), so a token-endpoint blip must not cancel a probe that the still-valid
      // stored access token would have passed. Only a dead grant is terminal.
      let refreshed = keyVaults;
      if (snapshot.provider.encryptedKeyVaults && snapshot.provider.secretFingerprint) {
        try {
          refreshed = await refreshSharedOAuthVault({
            ciphertext: snapshot.provider.encryptedKeyVaults,
            db: this.db,
            fingerprint: snapshot.provider.secretFingerprint,
            keyVaults,
            providerKey: snapshot.provider.providerKey,
            providerRowId: snapshot.provider.id,
            secrets: this.secrets,
          });
        } catch (error) {
          if (isOAuthAuthorizationExpiredError(error) || isSharedOAuthRefreshConsumedError(error)) {
            throw error;
          }
          // Transient — keep the stored vault and let the probe be the real verdict.
          refreshed = keyVaults;
        }
      }
      const normalized = normalizeAiCatalogExecutionCredentials({
        config: snapshot.provider.config,
        keyVaults: refreshed,
        providerKey: snapshot.provider.providerKey,
        source: snapshot.provider.source,
        settings: snapshot.provider.settings,
      });
      /**
       * Every runtime that presents an installation identity upstream gets the SAME
       * persisted profile the chat path uses — a probe that goes out as a different
       * device than production is not a probe of production (and for Grok a missing
       * profile used to mean the package's constant agent id).
       */
      const browserProfile = await resolvePlatformBrowserProfile(
        this.db,
        normalized.runtimeProvider,
      );
      return await this.connectionTests.test({
        browserProfile,
        keyVaults: normalized.keyVaults,
        model: snapshot.model!.modelKey,
        provider: snapshot.provider,
        runtimeProvider: normalized.runtimeProvider,
      });
    } catch (error) {
      // A dead shared grant is its own actionable state, not a generic config error.
      // Same stable codes as the probe itself (`llm.checker.reason.*`): this branch used to
      // mint English prose that every locale rendered verbatim, and the shared-account code
      // is what survives into persisted state for a superseded attempt to replay.
      const expired = isOAuthAuthorizationExpiredError(error);
      return {
        errorCategory: expired ? 'auth' : 'invalid_config',
        ...(expired ? { errorType: 'OAuthAuthorizationExpired' as const } : {}),
        latencyMs: 0,
        sanitizedMessage: aiConnectionFailureCode(
          expired ? 'auth' : 'invalid_config',
          expired ? 'OAuthAuthorizationExpired' : undefined,
        ),
        status: 'failure',
        testedAt: new Date(),
      };
    }
  }

  private async finalizeConnectionTest(
    id: string,
    attemptId: string,
    result: AiConnectionTestResult,
    actorUserId: string,
    reason: string,
  ): Promise<ConnectionTestFinalized> {
    return this.db.transaction(async (tx) => {
      const applied = await new PlatformAiCatalogRepository(tx).completeProviderConnectionTest(
        id,
        attemptId,
        {
          connectionTestErrorCategory: result.errorCategory,
          connectionTestLatencyMs: result.latencyMs,
          connectionTestSanitizedMessage: result.sanitizedMessage,
          connectionTestStatus: result.status,
          connectionTestedAt: result.testedAt,
        },
      );
      if (!applied) return { applied: false as const };
      await new PlatformAuditService(tx).append({
        action: 'admin.aiProviders.test',
        actorUserId,
        afterDiff: {
          errorCategory: result.errorCategory,
          latencyMs: result.latencyMs,
          status: result.status,
        },
        reason,
        result: result.status === 'success' ? 'success' : 'failure',
        targetId: id,
        targetType: 'provider',
      });
      return { applied: true as const, result };
    });
  }

  private async readSupersededConnectionTestResult(id: string): Promise<AiConnectionTestResult> {
    // Superseded attempt (CAS no-op): return the authoritative persisted state without auditing.
    const detail = await new PlatformAiCatalogModel(this.db).getProvider(id);
    if (!detail) throw new AiCatalogNotFoundError();
    const current = detail.connectionTest;
    if (current && (current.status === 'success' || current.status === 'failure')) {
      return {
        errorCategory: current.errorCategory,
        latencyMs: current.latencyMs ?? 0,
        sanitizedMessage: current.sanitizedMessage,
        status: current.status,
        testedAt: current.testedAt,
      };
    }
    // Newer attempt still pending — surface as non-audited validation (not a probe failure).
    throw new AiCatalogValidationError(['Connection test superseded by a newer attempt']);
  }
}

/**
 * Distinct, sanitized reasons — one blanket "invalid provider configuration" was
 * unactionable: the operator could not tell "pick a model" from "enable the model" from
 * "the provider rejected us".
 *
 * CONTRACT WITH THE ADMIN CHECKER: it normalizes this message (lowercase,
 * non-alphanumeric → `_`) and keys actionable copy off `check_model_not_configured` /
 * `check_model_not_enabled`. Keep these two phrases normalizing to exactly those codes;
 * anything else degrades to being shown verbatim, which is the intended fallback.
 */
const resolveCheckModelIssue = (snapshot: ConnectionTestSnapshot): string | null => {
  if (!snapshot.requestedModel) return 'Check model not configured';
  // Not materialized as a platform row and explicitly disabled are the same fix for the
  // operator ("enable it for this provider"), so they share one code.
  if (!snapshot.model || !snapshot.model.enabled) return 'Check model not enabled';
  if (snapshot.model.type !== 'chat') return 'Check model is not a chat model';
  return null;
};
