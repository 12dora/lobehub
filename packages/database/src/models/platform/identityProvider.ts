import type { PlatformIdentityProviderDraft } from '@lobechat/types';

import { PlatformIdentityProviderRepository } from '../../repositories/platformIdentityProvider';
import type { PlatformIdentityProviderItem } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

const toSafeDraft = (row: PlatformIdentityProviderItem): PlatformIdentityProviderDraft => ({
  activationRevision: row.activationRevision ?? null,
  autoProvision: row.autoProvision,
  buttonLabel: row.buttonLabel,
  claimMapping: row.claimMapping,
  clientId: row.clientId,
  displayName: row.displayName,
  domainAllowlist: row.domainAllowlist,
  enabled: row.enabled,
  groupRoleMapping: row.groupRoleMapping,
  icon: row.icon ?? null,
  id: row.id,
  issuer: row.issuer,
  providerKey: row.providerKey,
  revision: row.revision,
  scopes: row.scopes,
  secret: {
    configured: row.secretRef !== null,
    fingerprint: row.secretFingerprint ?? null,
    updatedAt: row.secretUpdatedAt ?? null,
  },
  status: row.status,
  type: row.type,
  usePkce: row.usePkce,
});

/** Secret-safe database model used by every future API/revision projection. */
export class PlatformIdentityProviderModel {
  private readonly repository: PlatformIdentityProviderRepository;

  constructor(db: LobeChatDatabase | Transaction) {
    this.repository = new PlatformIdentityProviderRepository(db);
  }

  get = async (id: string): Promise<PlatformIdentityProviderDraft | undefined> => {
    const row = await this.repository.get(id);
    return row ? toSafeDraft(row) : undefined;
  };

  list = async (): Promise<PlatformIdentityProviderDraft[]> =>
    (await this.repository.list()).map(toSafeDraft);

  /** Revision seed deliberately contains only configured/fingerprint metadata. */
  prepareRevisionPayload = async (id: string): Promise<PlatformIdentityProviderDraft | null> =>
    (await this.get(id)) ?? null;
}
