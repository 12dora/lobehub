// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('AIHub electron-builder metadata', () => {
  it('contains no user-visible LobeHub identity in the effective AIHub config', async () => {
    const assetsDirectory = await mkdtemp(path.join(tmpdir(), 'aihub-builder-assets-'));
    await Promise.all(
      ['Icon.icns', 'icon.ico', 'icon.png'].map((file) =>
        writeFile(path.join(assetsDirectory, file), 'approved'),
      ),
    );

    const script = `
      const { default: config } = await import('./apps/desktop/electron-builder.mjs');
      console.log(JSON.stringify({
        appId: config.appId,
        extraMetadata: config.extraMetadata,
        linux: {
          description: config.linux.description,
          maintainer: config.linux.maintainer,
          synopsis: config.linux.synopsis,
        },
        productName: config.productName,
        protocols: config.protocols,
        publish: config.publish,
        win: { executableName: config.win.executableName },
      }));
    `;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '--eval', script],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AIHUB_DESKTOP_APP_ID: 'com.example.aihub.desktop',
            AIHUB_DESKTOP_ASSETS_DIR: assetsDirectory,
            AIHUB_DESKTOP_HOMEPAGE: 'https://aihub.example.com/',
            AIHUB_DESKTOP_MAINTAINER: 'AIHub Release Team <release@example.com>',
            AIHUB_REQUIRE_SIGNING: '0',
            DESKTOP_BRAND: 'aihub',
            UPDATE_CHANNEL: 'stable',
            UPDATE_SERVER_URL: 'https://updates.example.com/releases/aihub',
          },
        },
      );
      const effectiveConfig = JSON.parse(stdout.trim().split('\n').at(-1)!);

      expect(effectiveConfig).toMatchObject({
        appId: 'com.example.aihub.desktop',
        extraMetadata: {
          description: 'AIHub Desktop Application',
          homepage: 'https://aihub.example.com/',
        },
        linux: {
          description: 'AIHub Desktop Application',
          maintainer: 'AIHub Release Team <release@example.com>',
          synopsis: 'AIHub Desktop',
        },
        productName: 'AIHub',
        protocols: [],
        win: { executableName: 'AIHub' },
      });
      expect(JSON.stringify(effectiveConfig)).not.toMatch(/lobehub/i);
    } finally {
      await rm(assetsDirectory, { force: true, recursive: true });
    }
  });
});
