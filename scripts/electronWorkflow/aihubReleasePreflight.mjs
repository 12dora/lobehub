import { parseAihubExternalUrl, rejectLobehubExternalBrandValue } from './desktopBranding.mjs';

const MAIN_REF = 'refs/heads/main';
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Z.-]+)?(?:\+[0-9A-Z.-]+)?$/i;
const SHA256_PATTERN = /^[a-f\d]{64}$/;

const requireValue = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Required AIHub release configuration is missing: ${name}`);
  return value;
};

const requireAll = (env, names) => {
  for (const name of names) requireValue(env, name);
};

export const validateAihubReleaseInputs = (env) => {
  const releaseRef = requireValue(env, 'RELEASE_REF');
  const releaseRefName = requireValue(env, 'RELEASE_REF_NAME');
  if (releaseRef !== MAIN_REF || releaseRefName !== 'main') {
    throw new Error('AIHub desktop builds and publishing are restricted to the main branch');
  }

  if (env.CONFIRMATION !== 'RELEASE-AIHUB-DESKTOP') {
    throw new Error('AIHub desktop release confirmation did not match');
  }

  const version = requireValue(env, 'VERSION');
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error('AIHub desktop version must be valid SemVer without a v prefix');
  }

  const buildLinux = env.BUILD_LINUX === 'true';
  const buildMacos = env.BUILD_MACOS === 'true';
  const buildWindows = env.BUILD_WINDOWS === 'true';
  if (!buildLinux && !buildMacos && !buildWindows) {
    throw new Error('At least one AIHub desktop platform must be selected');
  }

  requireAll(env, [
    'AIHUB_APP_ID',
    'AIHUB_APP_URL',
    'AIHUB_ASSET_REPOSITORY',
    'AIHUB_ASSET_TOKEN',
    'AIHUB_BUILD_KEY',
    'AIHUB_MAINTAINER',
    'AIHUB_UPDATE_URL',
  ]);

  const appUrl = parseAihubExternalUrl(env.AIHUB_APP_URL, 'AIHUB_APP_URL');
  rejectLobehubExternalBrandValue(env.AIHUB_MAINTAINER, 'AIHUB_MAINTAINER');

  if (appUrl.protocol !== 'https:') {
    throw new Error('AIHUB_APP_URL must use HTTPS');
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.AIHUB_ASSET_REPOSITORY)) {
    throw new Error('AIHUB_ASSET_REPOSITORY must be an owner/repository pair');
  }
  if (!/^[a-f\d]{40}$/.test(env.AIHUB_ASSET_REF ?? '')) {
    throw new Error('AIHUB_ASSET_REF must be an immutable 40-character commit SHA');
  }

  for (const name of ['AIHUB_ICON_ICNS_SHA256', 'AIHUB_ICON_ICO_SHA256', 'AIHUB_ICON_PNG_SHA256']) {
    if (!SHA256_PATTERN.test(env[name] ?? '')) {
      throw new Error(`${name} must be a SHA-256 digest`);
    }
  }

  if (buildMacos) {
    requireAll(env, [
      'AIHUB_APPLE_CERTIFICATE',
      'AIHUB_APPLE_CERTIFICATE_PASSWORD',
      'AIHUB_APPLE_ID',
      'AIHUB_APPLE_PASSWORD',
      'AIHUB_APPLE_TEAM_ID',
    ]);
  }
  if (buildWindows) {
    requireAll(env, ['AIHUB_WINDOWS_CERTIFICATE', 'AIHUB_WINDOWS_CERTIFICATE_PASSWORD']);
  }
  if (env.PUBLISH === 'true') {
    requireAll(env, [
      'AIHUB_S3_ACCESS_KEY',
      'AIHUB_S3_BUCKET',
      'AIHUB_S3_REGION',
      'AIHUB_S3_SECRET_KEY',
    ]);
  }

  const include = [];
  if (buildMacos) {
    include.push(
      { name: 'macos-arm64', os: 'macos-15', platform: 'macos' },
      { name: 'macos-x64', os: 'macos-15-intel', platform: 'macos' },
    );
  }
  if (buildWindows) {
    include.push({ name: 'windows-x64', os: 'windows-2025', platform: 'windows' });
  }
  if (buildLinux) include.push({ name: 'linux-x64', os: 'ubuntu-latest', platform: 'linux' });

  return { include };
};
