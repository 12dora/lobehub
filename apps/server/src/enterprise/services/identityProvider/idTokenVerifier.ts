import { createHash, timingSafeEqual } from 'node:crypto';

import {
  OIDC_ALLOWED_ID_TOKEN_SIGNING_ALGORITHMS,
  type PlatformOidcDiscoveryMetadata,
} from '@lobechat/types';
import { decodeProtectedHeader, importJWK, type JWK, type JWTPayload, jwtVerify } from 'jose';
import { z } from 'zod';

import type { SafeOutboundHttpClient } from '../../security/outboundHttp';

const TOKEN_TIMEOUT_MS = 5000;
const TOKEN_MAX_BYTES = 64 * 1024;
const ID_TOKEN_MAX_AGE_SECONDS = 10 * 60;
const ID_TOKEN_MAX_LIFETIME_SECONDS = 60 * 60;
const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 60;

const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(64) });

export type OidcNoncePolicy =
  { expectedHash: string; mode: 'required' } | { mode: 'not_requested' };

export interface VerifiedPlatformOidcIdToken extends JWTPayload {
  sub: string;
}

const safeJson = async (response: Awaited<ReturnType<SafeOutboundHttpClient['fetch']>>) => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    !response.ok ||
    response.truncated ||
    (contentType !== 'application/json' && !contentType?.endsWith('+json'))
  ) {
    throw new Error('PLATFORM_OIDC_ID_TOKEN_INVALID');
  }
  return response.json();
};

const assertNonce = (payload: JWTPayload, policy: OidcNoncePolicy): void => {
  if (policy.mode === 'not_requested') {
    if (payload.nonce !== undefined && typeof payload.nonce !== 'string') {
      throw new Error('PLATFORM_OIDC_ID_TOKEN_INVALID');
    }
    return;
  }

  if (typeof payload.nonce !== 'string') throw new Error('PLATFORM_OIDC_NONCE_INVALID');
  const actual = Buffer.from(createHash('sha256').update(payload.nonce).digest('hex'), 'hex');
  const expected = Buffer.from(policy.expectedHash, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('PLATFORM_OIDC_NONCE_INVALID');
  }
};

/** Verify a platform OIDC ID token against discovery-pinned metadata and JWKS. */
export const verifyPlatformOidcIdToken = async (input: {
  clientId: string;
  idToken: string;
  metadata: PlatformOidcDiscoveryMetadata;
  nonce: OidcNoncePolicy;
  outbound: SafeOutboundHttpClient;
}): Promise<VerifiedPlatformOidcIdToken> => {
  try {
    const header = decodeProtectedHeader(input.idToken);
    if (
      !header.alg ||
      typeof header.kid !== 'string' ||
      !header.kid ||
      !OIDC_ALLOWED_ID_TOKEN_SIGNING_ALGORITHMS.includes(
        header.alg as (typeof OIDC_ALLOWED_ID_TOKEN_SIGNING_ALGORITHMS)[number],
      ) ||
      !input.metadata.idTokenSigningAlgValuesSupported.includes(header.alg)
    ) {
      throw new Error('PLATFORM_OIDC_ID_TOKEN_INVALID');
    }

    const jwks = jwksSchema.parse(
      await safeJson(
        await input.outbound.fetch(input.metadata.jwksUri, {
          headers: { Accept: 'application/json' },
          maxRedirects: 0,
          maxResponseBytes: TOKEN_MAX_BYTES,
          method: 'GET',
          timeoutMs: TOKEN_TIMEOUT_MS,
        }),
      ),
    );
    const kidMatches = jwks.keys.filter((key) => key.kid === header.kid);
    if (kidMatches.length !== 1) throw new Error('PLATFORM_OIDC_ID_TOKEN_INVALID');
    const candidate = kidMatches[0]!;
    if (candidate.alg !== undefined && candidate.alg !== header.alg) {
      throw new Error('PLATFORM_OIDC_ID_TOKEN_INVALID');
    }

    const key = await importJWK(candidate as JWK, header.alg);
    const { payload } = await jwtVerify(input.idToken, key, {
      algorithms: [header.alg],
      audience: input.clientId,
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
      issuer: input.metadata.issuer,
    });
    const now = Math.floor(Date.now() / 1000);
    if (
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      payload.iat! > now + ID_TOKEN_CLOCK_TOLERANCE_SECONDS ||
      now - payload.iat! > ID_TOKEN_MAX_AGE_SECONDS ||
      payload.exp! <= payload.iat! ||
      payload.exp! - payload.iat! > ID_TOKEN_MAX_LIFETIME_SECONDS
    ) {
      throw new Error('PLATFORM_OIDC_ID_TOKEN_INVALID');
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (audiences.some((audience) => typeof audience !== 'string') || audiences.length === 0) {
      throw new Error('PLATFORM_OIDC_ID_TOKEN_INVALID');
    }
    if (
      (payload.azp !== undefined && payload.azp !== input.clientId) ||
      (audiences.length > 1 && payload.azp !== input.clientId)
    ) {
      throw new Error('PLATFORM_OIDC_ID_TOKEN_INVALID');
    }

    assertNonce(payload, input.nonce);
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new Error('PLATFORM_OIDC_ID_TOKEN_INVALID');
    }
    return { ...payload, sub: payload.sub };
  } catch (error) {
    if (error instanceof Error && error.message === 'PLATFORM_OIDC_NONCE_INVALID') throw error;
    throw new Error('PLATFORM_OIDC_ID_TOKEN_INVALID', { cause: error });
  }
};
