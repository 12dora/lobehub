// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  applyAihubPackageMetadata,
  materializeDesktopBrandAssets,
  resolveDesktopBranding,
  validateDesktopIcon,
} from '../../scripts/electronWorkflow/desktopBranding.mjs';

const createAihubEnv = () => ({
  AIHUB_DESKTOP_APP_ID: 'com.example.aihub.desktop',
  AIHUB_DESKTOP_ASSETS_DIR: '/approved/aihub-icons',
  AIHUB_DESKTOP_HOMEPAGE: 'https://aihub.example.com/',
  AIHUB_DESKTOP_MAINTAINER: 'AIHub Release Team <release@example.com>',
  DESKTOP_BRAND: 'aihub',
  UPDATE_CHANNEL: 'stable',
  UPDATE_SERVER_URL: 'https://updates.example.com/releases/aihub',
});

const createIcon = (format: 'icns' | 'ico' | 'png', size = 512) => {
  const buffer = Buffer.alloc(size);

  if (format === 'png') {
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  } else if (format === 'icns') {
    buffer.write('icns', 0, 'ascii');
    buffer.writeUInt32BE(buffer.length, 4);
  } else {
    Buffer.from([0, 0, 1, 0, 1, 0]).copy(buffer);
  }

  return buffer;
};

describe('desktop branding config', () => {
  it('preserves the LobeHub package profile unless AIHub is explicitly selected', () => {
    expect(resolveDesktopBranding({ env: {} })).toEqual({
      appId: 'com.lobehub.lobehub-desktop',
      brand: 'lobehub',
      isAIHub: false,
      productName: undefined,
    });
  });

  it('selects isolated AIHub naming and update configuration', () => {
    expect(resolveDesktopBranding({ env: createAihubEnv(), fileExists: () => true })).toMatchObject(
      {
        appId: 'com.example.aihub.desktop',
        brand: 'aihub',
        description: 'AIHub Desktop Application',
        homepage: 'https://aihub.example.com/',
        isAIHub: true,
        maintainer: 'AIHub Release Team <release@example.com>',
        productName: 'AIHub',
        updateServerUrl: 'https://updates.example.com/releases/aihub',
      },
    );
  });

  it.each([
    [{ ...createAihubEnv(), AIHUB_DESKTOP_APP_ID: '' }, 'AIHUB_DESKTOP_APP_ID is required'],
    [
      { ...createAihubEnv(), AIHUB_DESKTOP_APP_ID: 'com.lobehub.aihub.desktop' },
      'must not reuse the LobeHub',
    ],
    [{ ...createAihubEnv(), UPDATE_CHANNEL: 'canary' }, 'only support the isolated stable'],
    [
      { ...createAihubEnv(), UPDATE_SERVER_URL: 'https://updates.example.com/stable' },
      'must end with /aihub',
    ],
    [
      { ...createAihubEnv(), UPDATE_SERVER_URL: 'http://updates.example.com/aihub' },
      'must use HTTPS',
    ],
    [
      { ...createAihubEnv(), UPDATE_SERVER_URL: 'https://updates.example.com/aihub/' },
      'must not have a trailing slash',
    ],
    [
      { ...createAihubEnv(), AIHUB_DESKTOP_HOMEPAGE: 'https://LoBeHuB.example.com/' },
      'must not expose the LobeHub brand',
    ],
    [
      { ...createAihubEnv(), AIHUB_DESKTOP_MAINTAINER: 'LobeHub Release Team' },
      'must not expose the LobeHub brand',
    ],
  ])('fails closed for invalid AIHub configuration', (env, message) => {
    expect(() => resolveDesktopBranding({ env, fileExists: () => true })).toThrow(message);
  });

  it('changes only approved user-visible package metadata fields', () => {
    const packageMetadata = {
      author: 'Upstream Author',
      description: 'Upstream description',
      homepage: 'https://upstream.example.com/',
      legalTrademarks: 'Upstream legal text',
      license: 'MIT',
      name: 'lobehub-desktop',
      productName: 'LobeHub',
      repository: { type: 'git', url: 'https://example.com/upstream.git' },
    };

    expect(
      applyAihubPackageMetadata({
        homepage: 'https://aihub.example.com/',
        packageMetadata,
      }),
    ).toEqual({
      ...packageMetadata,
      description: 'AIHub Desktop Application',
      homepage: 'https://aihub.example.com/',
      productName: 'AIHub',
    });
    expect(() =>
      applyAihubPackageMetadata({
        homepage: 'https://products.LOBEHUB.example.com/',
        packageMetadata,
      }),
    ).toThrow('must not expose the LobeHub brand');
  });

  it('fails closed when an approved icon is missing', () => {
    expect(() =>
      resolveDesktopBranding({
        env: createAihubEnv(),
        fileExists: (file) => !file.endsWith('icon.ico'),
      }),
    ).toThrow('Required AIHub desktop icon is missing: icon.ico');
  });

  it('requires platform signing secrets when signed output is requested', () => {
    expect(() =>
      resolveDesktopBranding({
        env: { ...createAihubEnv(), AIHUB_REQUIRE_SIGNING: '1' },
        fileExists: () => true,
        platform: 'darwin',
      }),
    ).toThrow('APPLE_APP_SPECIFIC_PASSWORD is required');
  });
});

describe('AIHub icon materialization', () => {
  it('validates file signatures and exact SHA-256 digests', () => {
    for (const format of ['png', 'icns', 'ico'] as const) {
      const buffer = createIcon(format);
      const expectedDigest = createHash('sha256').update(buffer).digest('hex');
      expect(() => validateDesktopIcon({ buffer, expectedDigest, format })).not.toThrow();
    }
  });

  it('rejects valid-looking icons when the approved digest differs', () => {
    expect(() =>
      validateDesktopIcon({
        buffer: createIcon('png'),
        expectedDigest: '0'.repeat(64),
        format: 'png',
      }),
    ).toThrow('SHA-256 does not match');
  });

  it('materializes approved icon files larger than the GitHub Secret size limit', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'aihub-icons-'));
    const directory = path.join(temporaryRoot, 'output');
    const sourceDirectory = path.join(temporaryRoot, 'private-assets');
    const env: Record<string, string> = {};
    await mkdir(sourceDirectory);

    for (const format of ['png', 'icns', 'ico'] as const) {
      const upperFormat = format.toUpperCase();
      const buffer = createIcon(format, 64 * 1024);
      env[`AIHUB_DESKTOP_ICON_${upperFormat}_SHA256`] = createHash('sha256')
        .update(buffer)
        .digest('hex');
      const fileName = format === 'icns' ? 'Icon.icns' : `icon.${format}`;
      await writeFile(path.join(sourceDirectory, fileName), buffer);
    }

    try {
      await expect(
        materializeDesktopBrandAssets({ directory, env, sourceDirectory }),
      ).resolves.toBeUndefined();
      expect((await readFile(path.join(directory, 'Icon.icns'))).length).toBeGreaterThan(48 * 1024);
      expect(
        resolveDesktopBranding({
          env: { ...createAihubEnv(), AIHUB_DESKTOP_ASSETS_DIR: directory },
        }).icons,
      ).toEqual({
        icns: path.join(directory, 'Icon.icns'),
        ico: path.join(directory, 'icon.ico'),
        png: path.join(directory, 'icon.png'),
      });
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});
