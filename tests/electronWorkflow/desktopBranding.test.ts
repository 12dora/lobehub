// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  materializeDesktopBrandAssets,
  resolveDesktopBranding,
  validateAihubReleaseArtifacts,
  validateDesktopIcon,
} from '../../scripts/electronWorkflow/desktopBranding.mjs';

const createAihubEnv = () => ({
  AIHUB_DESKTOP_APP_ID: 'com.example.aihub.desktop',
  AIHUB_DESKTOP_ASSETS_DIR: '/approved/aihub-icons',
  DESKTOP_BRAND: 'aihub',
  UPDATE_CHANNEL: 'stable',
  UPDATE_SERVER_URL: 'https://updates.example.com/releases/aihub',
});

const createIcon = (format: 'icns' | 'ico' | 'png') => {
  const buffer = Buffer.alloc(512);

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
        isAIHub: true,
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
  ])('fails closed for invalid AIHub configuration', (env, message) => {
    expect(() => resolveDesktopBranding({ env, fileExists: () => true })).toThrow(message);
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

  it('materializes all required formats without logging encoded inputs', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aihub-icons-'));
    const env: Record<string, string> = {};

    for (const format of ['png', 'icns', 'ico'] as const) {
      const upperFormat = format.toUpperCase();
      const buffer = createIcon(format);
      env[`AIHUB_DESKTOP_ICON_${upperFormat}_BASE64`] = buffer.toString('base64');
      env[`AIHUB_DESKTOP_ICON_${upperFormat}_SHA256`] = createHash('sha256')
        .update(buffer)
        .digest('hex');
    }

    try {
      await expect(materializeDesktopBrandAssets({ directory, env })).resolves.toBeUndefined();
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
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe('AIHub release artifact isolation', () => {
  it('accepts AIHub installers referenced by isolated update manifests', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aihub-release-'));
    try {
      await writeFile(path.join(directory, 'AIHub-1.2.3-x64.dmg'), 'installer');
      await writeFile(
        path.join(directory, 'stable-mac.yml'),
        'version: 1.2.3\nfiles:\n  - url: AIHub-1.2.3-x64.dmg\n',
      );
      await expect(validateAihubReleaseArtifacts(directory)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects LobeHub installers or manifest references', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aihub-release-'));
    try {
      await mkdir(path.join(directory, 'nested'));
      await writeFile(path.join(directory, 'AIHub-1.2.3.exe'), 'installer');
      await writeFile(
        path.join(directory, 'nested', 'latest.yml'),
        'version: 1.2.3\npath: LobeHub-1.2.3-setup.exe\n',
      );
      await expect(validateAihubReleaseArtifacts(directory)).rejects.toThrow(
        'update manifest references LobeHub',
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
