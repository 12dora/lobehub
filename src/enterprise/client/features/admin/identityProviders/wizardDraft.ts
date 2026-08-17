import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { DEFAULT_IDP_BUTTON_LABEL } from '@lobechat/types';

import type { IdentityProviderCreateDraftSeed } from './controller';
import type { EditableDraft } from './steps';

export const DEFAULT_IDENTITY_PROVIDER_SEED: IdentityProviderCreateDraftSeed = {
  buttonLabel: DEFAULT_IDP_BUTTON_LABEL,
  claimMapping: {
    dingtalkTitle: [],
    dingtalkUserId: [],
    email: ['email'],
    name: ['name', 'preferred_username'],
    picture: ['picture'],
    subject: ['sub'],
  },
  icon: null,
  issuer: '',
  scopes: ['openid', 'profile', 'email'],
  type: 'generic_oidc',
  usePkce: true,
};

export const fromSeed = (seed: IdentityProviderCreateDraftSeed): EditableDraft => ({
  autoProvision: true,
  buttonLabel: seed.buttonLabel,
  claimMapping: structuredClone(seed.claimMapping),
  clientId: '',
  dingtalkAllowedCorps: [],
  displayName: '',
  domainAllowlist: [],
  groupRoleMapping: {},
  icon: seed.icon,
  issuer: seed.issuer,
  providerKey: '',
  scopes: [...seed.scopes],
  type: seed.type,
  usePkce: true,
});

export const fromProvider = (provider: PlatformIdentityProviderDraft): EditableDraft => ({
  autoProvision: provider.autoProvision,
  buttonLabel: provider.buttonLabel,
  claimMapping: structuredClone(provider.claimMapping),
  clientId: provider.clientId ?? '',
  dingtalkAllowedCorps: provider.dingtalkAllowedCorps.map((entry) => ({ ...entry })),
  displayName: provider.displayName,
  domainAllowlist: [...provider.domainAllowlist],
  // Preserve existing mapping across unrelated edits; Policy UI edits remain out of scope
  // until a dedicated group-mapping editor ships. Runtime enforces non-empty maps at login.
  groupRoleMapping: { ...provider.groupRoleMapping },
  icon: provider.icon,
  issuer: provider.issuer ?? '',
  providerKey: provider.providerKey,
  scopes: [...provider.scopes],
  type: provider.type,
  usePkce: true,
});
