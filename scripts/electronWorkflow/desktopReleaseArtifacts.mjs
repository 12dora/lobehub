import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';
import { z } from 'zod';

import { AIHUB_PRODUCT_NAME } from './desktopBranding.mjs';

const releaseFileSchema = z.object({ url: z.string().min(1) }).passthrough();
const releaseManifestSchema = z
  .object({
    files: z.array(releaseFileSchema).min(1),
    path: z.string().min(1),
    version: z.string().min(1),
  })
  .passthrough();

const RELEASE_ARTIFACT_PATTERN = /\.(?:appimage|blockmap|deb|dmg|exe|rpm|snap|tar\.gz|zip)$/i;
const SAFE_SEGMENT_PATTERN = /^[a-z\d][\w.+-]*$/i;

const listFilesRecursively = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFilesRecursively(entryPath) : [entryPath];
    }),
  );
  return nested.flat();
};

const validatePrefix = (expectedPrefix) => {
  if (expectedPrefix && !SAFE_SEGMENT_PATTERN.test(expectedPrefix)) {
    throw new Error('AIHub release version prefix is unsafe');
  }
};

const validateArtifactReference = ({ artifactsByName, expectedPrefix, reference }) => {
  if (
    reference.includes('\\') ||
    reference.includes('%') ||
    reference.includes('?') ||
    reference.includes('#') ||
    reference.includes(':') ||
    path.posix.isAbsolute(reference)
  ) {
    throw new Error(`AIHub manifest contains an unsafe artifact reference: ${reference}`);
  }

  const segments = reference.split('/');
  const expectedSegments = expectedPrefix ? 2 : 1;
  if (
    segments.length !== expectedSegments ||
    segments.some((segment) => !SAFE_SEGMENT_PATTERN.test(segment)) ||
    (expectedPrefix && segments[0] !== expectedPrefix)
  ) {
    throw new Error(`AIHub manifest contains an unsafe artifact reference: ${reference}`);
  }

  const basename = segments.at(-1);
  if (!basename?.startsWith(`${AIHUB_PRODUCT_NAME}-`)) {
    throw new Error(`AIHub manifest references a non-AIHub artifact: ${reference}`);
  }

  if (!artifactsByName.has(basename)) {
    throw new Error(`AIHub manifest references a missing artifact: ${reference}`);
  }

  return basename;
};

const readManifest = async (manifestPath) => {
  const content = await readFile(manifestPath, 'utf8');
  if (/lobehub/i.test(content)) {
    throw new Error(`AIHub update manifest references LobeHub: ${path.basename(manifestPath)}`);
  }

  let parsed;
  try {
    parsed = YAML.parse(content);
  } catch {
    throw new Error(`AIHub update manifest is not valid YAML: ${path.basename(manifestPath)}`);
  }

  const result = releaseManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`AIHub update manifest has an invalid schema: ${path.basename(manifestPath)}`);
  }

  return result.data;
};

const collectReleaseFiles = async (directory) => {
  const files = await listFilesRecursively(directory);
  const artifacts = files.filter((file) => RELEASE_ARTIFACT_PATTERN.test(file));
  const manifests = files.filter((file) => file.endsWith('.yml'));

  if (artifacts.length === 0) throw new Error('AIHub release contains no installer artifacts');
  if (manifests.length === 0) throw new Error('AIHub release contains no update manifests');

  const artifactsByName = new Map();
  for (const artifact of artifacts) {
    const basename = path.basename(artifact);
    if (!basename.startsWith(`${AIHUB_PRODUCT_NAME}-`)) {
      throw new Error(`AIHub installer has an unexpected name: ${basename}`);
    }
    if (artifactsByName.has(basename)) {
      throw new Error(`AIHub release contains duplicate artifact names: ${basename}`);
    }
    artifactsByName.set(basename, artifact);
  }

  return { artifactsByName, manifests };
};

export const validateAihubReleaseArtifacts = async (directory, { expectedPrefix } = {}) => {
  validatePrefix(expectedPrefix);
  const { artifactsByName, manifests } = await collectReleaseFiles(directory);

  for (const manifestPath of manifests) {
    const manifest = await readManifest(manifestPath);
    const referencedFiles = new Set(
      manifest.files.map(({ url }) =>
        validateArtifactReference({ artifactsByName, expectedPrefix, reference: url }),
      ),
    );
    const primaryArtifact = validateArtifactReference({
      artifactsByName,
      expectedPrefix,
      reference: manifest.path,
    });

    if (!referencedFiles.has(primaryArtifact)) {
      throw new Error(
        `AIHub manifest path is not present in files: ${path.basename(manifestPath)}`,
      );
    }
  }
};

export const prepareAihubReleaseManifests = async (directory, versionPrefix) => {
  validatePrefix(versionPrefix);
  await validateAihubReleaseArtifacts(directory);
  const { manifests } = await collectReleaseFiles(directory);

  for (const manifestPath of manifests) {
    const manifest = await readManifest(manifestPath);
    manifest.files = manifest.files.map((file) => ({
      ...file,
      url: `${versionPrefix}/${path.posix.basename(file.url)}`,
    }));
    manifest.path = `${versionPrefix}/${path.posix.basename(manifest.path)}`;
    await writeFile(manifestPath, YAML.stringify(manifest));
  }

  await validateAihubReleaseArtifacts(directory, { expectedPrefix: versionPrefix });
};
