import type { AiCatalogAdminService } from '../../services/aiCatalog/adminService';
import type { RotatingOAuthProviderCard } from './aiProviderOAuthSupport.card';

type SharedProviderDetail = Awaited<ReturnType<AiCatalogAdminService['getDetail']>>;

export const applySharedConnectionVault = ({
  card,
  clearedIdentityLeaves,
  detail,
  providerKey,
  reason,
  service,
  userId,
  vault,
}: {
  card: RotatingOAuthProviderCard;
  clearedIdentityLeaves: string[];
  detail: SharedProviderDetail | undefined;
  providerKey: string;
  reason: string;
  service: AiCatalogAdminService;
  userId: string;
  vault: Record<string, string>;
}) =>
  detail
    ? service.applyProviderImmediate(userId, {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: detail.draft.id,
        mode: 'update',
        reason,
        secret: {
          operation: 'merge',
          ...(clearedIdentityLeaves.length > 0 ? { unset: clearedIdentityLeaves } : {}),
          value: vault,
        },
      })
    : service.applyProviderImmediate(userId, {
        // Without a check model the admin connectivity probe cannot run at all; the
        // builtin card already names the right default.
        checkModel: card.checkModel ?? null,
        description: card.description,
        displayName: card.name,
        // Connecting a shared account IS the activation intent, and the row is created
        // here for the first time — so first connect lands enabled and live. The update
        // branch above deliberately omits `enabled`: a reconnect must never re-enable a
        // provider the admin turned off on purpose.
        enabled: true,
        mode: 'create',
        providerKey,
        reason,
        secret: { operation: 'replace', value: vault },
        settings: card.settings,
        source: 'builtin',
      });
