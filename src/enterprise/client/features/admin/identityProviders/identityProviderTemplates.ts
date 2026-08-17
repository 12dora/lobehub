import {
  DINGTALK_IDENTITY_PROVIDER_ISSUER,
  PLATFORM_IDENTITY_PROVIDER_TEMPLATES,
  type PlatformIdentityProviderAllowedCorp,
  type PlatformIdentityProviderTemplate,
  type PlatformIdentityProviderType,
} from '@lobechat/types';

export type IdentityProviderCreateTemplateId = PlatformIdentityProviderType;

export interface IdentityProviderCreateDraftSeed {
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderTemplate['claimMapping'];
  icon: string | null;
  /** Pre-filled for kinds whose issuer is fixed by the protocol (e.g. DingTalk). */
  issuer: string;
  scopes: string[];
  type: PlatformIdentityProviderType;
  usePkce: true;
}

export const createIdentityProviderDraftFromTemplate = (
  type: IdentityProviderCreateTemplateId,
): IdentityProviderCreateDraftSeed => {
  const template = PLATFORM_IDENTITY_PROVIDER_TEMPLATES[type];
  return {
    buttonLabel: template.buttonLabel,
    claimMapping: structuredClone(template.claimMapping),
    icon: template.icon,
    issuer: type === 'dingtalk' ? DINGTALK_IDENTITY_PROVIDER_ISSUER : '',
    scopes: [...template.scopes],
    type: template.type,
    usePkce: true,
  };
};

/**
 * Kinds whose endpoints, claim mapping and issuer are fixed by the protocol. Their wizard
 * hides the discovery and claims steps and offers an organisation pin instead.
 */
export const isFixedProtocolIdentityProviderType = (type: PlatformIdentityProviderType): boolean =>
  type === 'dingtalk';

/**
 * Notes are held raw while the administrator types (so a trailing space before the next word is
 * not eaten on every keystroke) and normalised here, on the way to the API.
 */
export const serializeIdentityProviderAllowedCorps = (
  entries: readonly PlatformIdentityProviderAllowedCorp[],
): PlatformIdentityProviderAllowedCorp[] =>
  entries.map(({ corpName, label, ...entry }) => {
    const trimmedName = corpName?.trim();
    const trimmedLabel = label?.trim();
    return {
      ...entry,
      ...(trimmedName ? { corpName: trimmedName } : {}),
      ...(trimmedLabel ? { label: trimmedLabel } : {}),
    };
  });

/** Authentik issuer field placeholder used in the discovery step. */
export const AUTHENTIK_ISSUER_PLACEHOLDER = 'https://auth.example.com/application/o/<slug>/';
