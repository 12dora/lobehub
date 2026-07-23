import type { PlatformIdentityProviderDraft } from '@lobechat/types';

export type EditableDraft = {
  autoProvision: boolean;
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderDraft['claimMapping'];
  clientId: string;
  displayName: string;
  domainAllowlist: string[];
  groupRoleMapping: Record<string, string>;
  icon: string | null;
  issuer: string;
  providerKey: string;
  scopes: string[];
  type: 'authentik' | 'generic_oidc';
  usePkce: true;
};

export type PatchDraft = <Key extends keyof EditableDraft>(
  key: Key,
  value: EditableDraft[Key],
) => void;
