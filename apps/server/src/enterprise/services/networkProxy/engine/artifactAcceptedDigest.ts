import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import type { NetworkProxyArtifactKind } from '@/const/platform/networkProxy';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import { NETWORK_PROXY_ENGINE_ERROR_CODES, throwNetworkProxyError } from './errors';
import { removeIfPresent } from './fsSecure';

/** Side-file that records a digest an operator explicitly accepted despite the manifest mismatch. */
export const acceptedDigestPath = (artifactPath: string): string => `${artifactPath}.accepted`;

export interface AcceptedDigestClaim {
  digest: string;
  kind: NetworkProxyArtifactKind;
  /** The pinned manifest version / geodata commit this acceptance was granted under. */
  manifestVersion: string;
  /** What the accepted file really is (engine `-v` output); the manifest version for data files. */
  reportedVersion: string;
}

/**
 * The acceptance marker is sealed with the platform KEK (`PlatformSecretService`), so a writer
 * with nothing but access to the data volume cannot mint one: replacing the artifact still fails
 * verification unless the marker was produced by the authenticated upload path of this platform.
 * Without a configured master key the escape hatch is simply unavailable.
 */
let acceptedDigestSecretsOverride: PlatformSecretService | null | undefined;
const acceptedDigestSecrets = (): PlatformSecretService | null =>
  acceptedDigestSecretsOverride === undefined
    ? PlatformSecretService.tryFromEnv()
    : acceptedDigestSecretsOverride;

/** Test seam: inject the sealing service (or `null` to simulate a deployment without a KEK). */
export const setAcceptedDigestSecretsForTest = (
  service: PlatformSecretService | null | undefined,
): void => {
  acceptedDigestSecretsOverride = service;
};

export type AcceptedDigestLookup = Pick<AcceptedDigestClaim, 'kind' | 'manifestVersion'>;

const readAcceptedDigest = async (
  artifactPath: string,
  claim: AcceptedDigestLookup,
): Promise<{ digest: string; reportedVersion: string } | null> => {
  const secrets = acceptedDigestSecrets();
  if (!secrets) return null;
  try {
    const handle = await open(
      acceptedDigestPath(artifactPath),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let sealed: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) return null;
      sealed = (await handle.readFile({ encoding: 'utf8' })).trim();
    } finally {
      await handle.close();
    }
    const parsed = JSON.parse(await secrets.decrypt(sealed)) as Partial<AcceptedDigestClaim>;
    if (
      parsed.kind !== claim.kind ||
      parsed.manifestVersion !== claim.manifestVersion ||
      typeof parsed.digest !== 'string' ||
      !/^[\da-f]{64}$/u.test(parsed.digest) ||
      typeof parsed.reportedVersion !== 'string'
    ) {
      return null;
    }
    return { digest: parsed.digest, reportedVersion: parsed.reportedVersion };
  } catch {
    return null;
  }
};

/** Writes the sealed marker to `target` (a staging path; the caller renames it into place). */
export const writeAcceptedDigest = async (
  target: string,
  claim: AcceptedDigestClaim,
): Promise<void> => {
  const secrets = acceptedDigestSecrets();
  if (!secrets) {
    return throwNetworkProxyError(
      NETWORK_PROXY_ENGINE_ERROR_CODES.ARTIFACT_MISMATCH,
      'accepting a checksum mismatch requires a configured platform master key',
    );
  }
  const sealed = await secrets.encrypt(JSON.stringify(claim));
  await removeIfPresent(target);
  const handle = await open(
    target,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await handle.writeFile(`${sealed}\n`, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/**
 * A digest is acceptable when it equals the pinned manifest digest, or when it equals the
 * operator-accepted digest recorded next to the file. The second path exists only for a manual
 * upload where the administrator saw the mismatch warning and chose to proceed.
 */
export const isAcceptableDigest = async (
  path: string,
  digest: string,
  expectedSha256: string,
  claim: AcceptedDigestLookup | undefined,
): Promise<{ matched: boolean; ok: boolean; reportedVersion: string | null }> => {
  if (digest === expectedSha256) return { matched: true, ok: true, reportedVersion: null };
  if (!claim) return { matched: false, ok: false, reportedVersion: null };
  const accepted = await readAcceptedDigest(path, claim);
  const ok = accepted !== null && accepted.digest === digest;
  return { matched: false, ok, reportedVersion: ok ? accepted.reportedVersion : null };
};
