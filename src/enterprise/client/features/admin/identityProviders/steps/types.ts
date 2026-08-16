import type {
  PlatformIdentityProviderAllowedCorp,
  PlatformIdentityProviderDraft,
  PlatformIdentityProviderType,
} from '@lobechat/types';

export type EditableDraft = {
  autoProvision: boolean;
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderDraft['claimMapping'];
  clientId: string;
  dingtalkAllowedCorps: PlatformIdentityProviderAllowedCorp[];
  displayName: string;
  domainAllowlist: string[];
  groupRoleMapping: Record<string, string>;
  icon: string | null;
  issuer: string;
  providerKey: string;
  scopes: string[];
  type: PlatformIdentityProviderType;
  usePkce: true;
};

export type PatchDraft = <Key extends keyof EditableDraft>(
  key: Key,
  value: EditableDraft[Key],
) => void;
