import { randomUUID } from 'node:crypto';
import { chmod, rename } from 'node:fs/promises';
import path from 'node:path';

import debug from 'debug';

import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';

import type { ArtifactSpec, InstalledArtifact, InstallStreamOptions } from './artifacts';
import { acceptedDigestPath, rememberPinnedDigest, smokeTestEngineBinary } from './artifacts';
import { writeStreamToVerifiedFile } from './artifactStream';
import { ensureSecureDirectory, removeIfPresent, withInstallLock } from './fsSecure';
import { enginePaths, resolveDataDir } from './platform';

const log = debug('lobe-server:network-proxy-artifacts');

type WriteAcceptedDigest = (
  target: string,
  claim: {
    digest: string;
    kind: ArtifactSpec['kind'];
    manifestVersion: string;
    reportedVersion: string;
  },
) => Promise<void>;

export const installVerifiedStream = async (
  spec: ArtifactSpec,
  stream: NodeJS.ReadableStream,
  opts: InstallStreamOptions,
  writeAcceptedDigest: WriteAcceptedDigest,
): Promise<InstalledArtifact> => {
  const dataDir = resolveDataDir();
  const paths = enginePaths(dataDir);
  return withInstallLock(
    paths.lockPath,
    async () => {
      await ensureSecureDirectory(spec.destParent, { create: true, root: dataDir });
      const dest = path.join(spec.destParent, spec.destName);
      const tmpPath = `${dest}.${process.pid}.${randomUUID()}.tmp`;
      const { digest, matched } = await writeStreamToVerifiedFile({
        acceptMismatch: opts.acceptMismatch === true && opts.source === 'upload',
        compressed: opts.compressed,
        expectedSha256: spec.sha256,
        maxCompressed: NETWORK_PROXY_LIMITS.UPLOAD_MAX_COMPRESSED_BYTES,
        maxDecompressed: spec.size,
        mode: spec.mode,
        stream,
        tmpPath,
      });
      // Smoke-test the temporary file BEFORE it replaces the working copy: an accepted-but-broken
      // binary must not destroy a good install (and must not end up marked as accepted).
      let smokeOutput: string | null = null;
      let version = spec.version;
      if (spec.kind === 'engine') {
        try {
          const smoked = await smokeTestEngineBinary(tmpPath);
          smokeOutput = smoked.smokeOutput;
          // A verified file IS the pinned version; an accepted mismatch reports what it really is.
          if (!matched) version = smoked.version;
          log('engine smoke test: %s', smokeOutput);
        } catch (error) {
          await removeIfPresent(tmpPath);
          throw error;
        }
      }
      // The acceptance marker must describe exactly the file about to sit at `dest`. It is staged
      // next to the temp file and only swapped in after the artifact rename succeeded, so a
      // failure leaves the previous artifact AND its marker untouched. Sealing needs the platform
      // KEK — without one the mismatch is rejected before anything is replaced.
      const markerTmp = matched
        ? null
        : `${acceptedDigestPath(dest)}.${process.pid}.${randomUUID()}.tmp`;
      if (markerTmp) {
        try {
          await writeAcceptedDigest(markerTmp, {
            digest,
            kind: spec.kind,
            manifestVersion: spec.version,
            reportedVersion: version,
          });
        } catch (error) {
          await removeIfPresent(tmpPath);
          throw error;
        }
      }
      try {
        await rename(tmpPath, dest);
      } catch (error) {
        await removeIfPresent(tmpPath);
        if (markerTmp) await removeIfPresent(markerTmp);
        throw error;
      }
      await chmod(dest, spec.mode);
      if (markerTmp) await rename(markerTmp, acceptedDigestPath(dest));
      // A matching file replacing an accepted one drops the stale marker.
      else await removeIfPresent(acceptedDigestPath(dest));
      await rememberPinnedDigest(dest, digest);
      return {
        kind: spec.kind,
        path: dest,
        pinnedDigestMatch: matched,
        sha256: digest,
        smokeOutput,
        source: opts.source,
        version,
      };
    },
    dataDir,
  );
};
