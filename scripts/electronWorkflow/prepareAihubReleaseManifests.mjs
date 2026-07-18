import path from 'node:path';

import { prepareAihubReleaseManifests } from './desktopReleaseArtifacts.mjs';

const releaseDirectory = process.argv[2];
const versionPrefix = process.argv[3];
if (!releaseDirectory || !versionPrefix) {
  throw new Error('Usage: node prepareAihubReleaseManifests.mjs <release-directory> <version>');
}

await prepareAihubReleaseManifests(path.resolve(releaseDirectory), versionPrefix);
console.info('AIHub update manifests rewritten and validated.');
