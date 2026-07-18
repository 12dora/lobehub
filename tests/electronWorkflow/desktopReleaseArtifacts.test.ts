// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import {
  prepareAihubReleaseManifests,
  validateAihubReleaseArtifacts,
} from '../../scripts/electronWorkflow/desktopReleaseArtifacts.mjs';

const primaryArtifact = 'AIHub-1.2.3-setup.exe';
const blockmapArtifact = `${primaryArtifact}.blockmap`;

const writeRelease = async (manifest: unknown) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aihub-release-'));
  await Promise.all([
    writeFile(path.join(directory, primaryArtifact), 'installer'),
    writeFile(path.join(directory, blockmapArtifact), 'blockmap'),
    writeFile(path.join(directory, 'latest.yml'), YAML.stringify(manifest)),
  ]);
  return directory;
};

const validManifest = () => ({
  files: [{ url: primaryArtifact }, { url: blockmapArtifact }],
  path: primaryArtifact,
  releaseNotes: 'Approved AIHub release',
  version: '1.2.3',
});

describe('AIHub release artifact validation', () => {
  it('validates every file and rewrites every URL plus the top-level path', async () => {
    const directory = await writeRelease(validManifest());

    try {
      await expect(validateAihubReleaseArtifacts(directory)).resolves.toBeUndefined();
      await expect(prepareAihubReleaseManifests(directory, '1.2.3')).resolves.toBeUndefined();

      const rewritten = YAML.parse(await readFile(path.join(directory, 'latest.yml'), 'utf8'));
      expect(rewritten.files.map(({ url }: { url: string }) => url)).toEqual([
        `1.2.3/${primaryArtifact}`,
        `1.2.3/${blockmapArtifact}`,
      ]);
      expect(rewritten.path).toBe(`1.2.3/${primaryArtifact}`);
      await expect(
        validateAihubReleaseArtifacts(directory, { expectedPrefix: '1.2.3' }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    ['absolute URL', `https://updates.example.com/${primaryArtifact}`],
    ['absolute path', `/${primaryArtifact}`],
    ['parent traversal', `../${primaryArtifact}`],
    ['encoded traversal', `%2e%2e/${primaryArtifact}`],
    ['non-AIHub basename', 'LobeHub-1.2.3-setup.exe'],
    ['missing artifact', 'AIHub-1.2.3-missing.exe'],
  ])('rejects an unsafe %s in any files entry', async (_label, unsafeReference) => {
    const manifest = validManifest();
    manifest.files[1].url = unsafeReference;
    const directory = await writeRelease(manifest);

    try {
      await expect(validateAihubReleaseArtifacts(directory)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects a top-level path that is absent from the files list', async () => {
    const manifest = validManifest();
    manifest.path = blockmapArtifact;
    manifest.files = [{ url: primaryArtifact }];
    const directory = await writeRelease(manifest);

    try {
      await expect(validateAihubReleaseArtifacts(directory)).rejects.toThrow(
        'path is not present in files',
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('does not accept a branded release note as a substitute for safe artifact fields', async () => {
    const manifest = {
      ...validManifest(),
      files: [{ url: 'unapproved.exe' }],
      path: 'unapproved.exe',
      releaseNotes: `Download ${primaryArtifact}`,
    };
    const directory = await writeRelease(manifest);

    try {
      await expect(validateAihubReleaseArtifacts(directory)).rejects.toThrow('non-AIHub artifact');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects LobeHub content anywhere in an AIHub manifest', async () => {
    const directory = await writeRelease({
      ...validManifest(),
      releaseNotes: 'See the LobeHub release notes',
    });

    try {
      await expect(validateAihubReleaseArtifacts(directory)).rejects.toThrow('references LobeHub');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
