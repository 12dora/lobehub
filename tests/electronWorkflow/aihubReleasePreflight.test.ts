// @vitest-environment node
import { validateAihubReleaseInputs } from '../../scripts/electronWorkflow/aihubReleasePreflight.mjs';

const createReleaseEnv = (overrides: Record<string, string> = {}) => ({
  AIHUB_APP_ID: 'com.example.aihub.desktop',
  AIHUB_APP_URL: 'https://aihub.example.com/',
  AIHUB_ASSET_REF: 'a'.repeat(40),
  AIHUB_ASSET_REPOSITORY: 'example/private-aihub-assets',
  AIHUB_ASSET_TOKEN: 'read-only-token',
  AIHUB_BUILD_KEY: 'isolated-build-key',
  AIHUB_ICON_ICNS_SHA256: 'b'.repeat(64),
  AIHUB_ICON_ICO_SHA256: 'c'.repeat(64),
  AIHUB_ICON_PNG_SHA256: 'd'.repeat(64),
  AIHUB_MAINTAINER: 'AIHub Release Team <release@example.com>',
  AIHUB_UPDATE_URL: 'https://updates.example.com/releases/aihub',
  BUILD_LINUX: 'true',
  BUILD_MACOS: 'false',
  BUILD_WINDOWS: 'false',
  CONFIRMATION: 'RELEASE-AIHUB-DESKTOP',
  PUBLISH: 'false',
  RELEASE_REF: 'refs/heads/main',
  RELEASE_REF_NAME: 'main',
  VERSION: '1.2.3',
  ...overrides,
});

describe('AIHub release preflight', () => {
  it('accepts an explicitly confirmed main-branch build with immutable assets', () => {
    expect(validateAihubReleaseInputs(createReleaseEnv())).toEqual({
      include: [{ name: 'linux-x64', os: 'ubuntu-latest', platform: 'linux' }],
    });
  });

  it.each(['false', 'true'])('rejects non-main and malicious refs when publish=%s', (publish) => {
    for (const [releaseRef, releaseRefName] of [
      ['refs/heads/canary', 'canary'],
      ['refs/pull/123/merge', 'main'],
      ['refs/heads/main;echo injected', 'main'],
      ['refs/heads/main', 'main\nmalicious'],
    ]) {
      expect(() =>
        validateAihubReleaseInputs(
          createReleaseEnv({
            PUBLISH: publish,
            RELEASE_REF: releaseRef,
            RELEASE_REF_NAME: releaseRefName,
          }),
        ),
      ).toThrow('restricted to the main branch');
    }
  });

  it('requires the exact human confirmation string', () => {
    expect(() =>
      validateAihubReleaseInputs(createReleaseEnv({ CONFIRMATION: 'release-aihub-desktop' })),
    ).toThrow('confirmation did not match');
  });

  it.each([
    ['AIHUB_ASSET_REF', 'main', 'immutable 40-character commit SHA'],
    ['AIHUB_ASSET_REF', 'a'.repeat(39), 'immutable 40-character commit SHA'],
    ['AIHUB_ASSET_TOKEN', '', 'AIHUB_ASSET_TOKEN'],
  ])('fails closed for invalid protected asset input %s', (name, value, message) => {
    expect(() => validateAihubReleaseInputs(createReleaseEnv({ [name]: value }))).toThrow(message);
  });

  it('requires platform signing inputs only for selected signed platforms', () => {
    expect(() =>
      validateAihubReleaseInputs(createReleaseEnv({ BUILD_LINUX: 'false', BUILD_MACOS: 'true' })),
    ).toThrow('AIHUB_APPLE_CERTIFICATE');
    expect(() =>
      validateAihubReleaseInputs(createReleaseEnv({ BUILD_LINUX: 'false', BUILD_WINDOWS: 'true' })),
    ).toThrow('AIHUB_WINDOWS_CERTIFICATE');
  });
});
