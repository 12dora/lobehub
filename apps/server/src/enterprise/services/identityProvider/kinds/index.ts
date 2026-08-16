import type { PlatformIdentityProviderType, PlatformOidcDiscoveryMetadata } from '@lobechat/types';

import { buildDingTalkDiscoveryMetadata } from './dingtalk';

export * from './dingtalk';

/** Kinds that are strict OpenID Connect: discovery, id_token, Bearer userinfo, mandatory email. */
export const isStrictOidcIdentityProviderType = (type: PlatformIdentityProviderType): boolean =>
  type !== 'dingtalk';

/**
 * Endpoint metadata for kinds that publish no discovery document.
 * `null` = the kind is strict OIDC and must be discovered over the network.
 */
export const resolveStaticIdentityProviderMetadata = (
  type: PlatformIdentityProviderType,
  issuer: string,
): PlatformOidcDiscoveryMetadata | null =>
  type === 'dingtalk' ? buildDingTalkDiscoveryMetadata(issuer) : null;
