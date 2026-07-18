import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const AIHUB_DESKTOP_BRAND = 'aihub';
export const AIHUB_PRODUCT_NAME = 'AIHub';
export const AIHUB_UPDATE_NAMESPACE = 'aihub';
export const AIHUB_DESKTOP_DESCRIPTION = 'AIHub Desktop Application';

const ICON_DEFINITIONS = [
  {
    digestEnv: 'AIHUB_DESKTOP_ICON_PNG_SHA256',
    fileName: 'icon.png',
    format: 'png',
  },
  {
    digestEnv: 'AIHUB_DESKTOP_ICON_ICNS_SHA256',
    fileName: 'Icon.icns',
    format: 'icns',
  },
  {
    digestEnv: 'AIHUB_DESKTOP_ICON_ICO_SHA256',
    fileName: 'icon.ico',
    format: 'ico',
  },
];

const MAX_ICON_BYTES = 20 * 1024 * 1024;
const MIN_ICON_BYTES = 256;
const UPSTREAM_BRAND_PATTERN = /lobehub/i;

const getRequiredEnv = (env, name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for AIHub desktop builds`);
  return value;
};

const validateAppId = (appId) => {
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){2,}$/i.test(appId)) {
    throw new Error('AIHUB_DESKTOP_APP_ID must be a reverse-DNS application identifier');
  }

  if (appId.toLowerCase().includes('lobehub')) {
    throw new Error('AIHUB_DESKTOP_APP_ID must not reuse the LobeHub application identifier');
  }
};

const validateUpdateServerUrl = (rawUrl) => {
  let updateUrl;
  try {
    updateUrl = new URL(rawUrl);
  } catch {
    throw new Error('UPDATE_SERVER_URL must be a valid URL for AIHub desktop builds');
  }

  if (updateUrl.protocol !== 'https:') {
    throw new Error('UPDATE_SERVER_URL must use HTTPS for AIHub desktop builds');
  }

  if (updateUrl.username || updateUrl.password || updateUrl.search || updateUrl.hash) {
    throw new Error(
      'UPDATE_SERVER_URL must not contain credentials, query parameters, or fragments',
    );
  }

  const segments = updateUrl.pathname.split('/').filter(Boolean);
  if (segments.at(-1) !== AIHUB_UPDATE_NAMESPACE) {
    throw new Error(`UPDATE_SERVER_URL must end with /${AIHUB_UPDATE_NAMESPACE}`);
  }

  if (updateUrl.pathname.endsWith('/')) {
    throw new Error('UPDATE_SERVER_URL must not have a trailing slash');
  }

  return updateUrl.toString();
};

export const rejectLobehubExternalBrandValue = (value, name) => {
  if (UPSTREAM_BRAND_PATTERN.test(value)) {
    throw new Error(`${name} must not expose the LobeHub brand in an AIHub build`);
  }
  return value;
};

export const parseAihubExternalUrl = (rawUrl, name) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  rejectLobehubExternalBrandValue(parsedUrl.toString(), name);
  rejectLobehubExternalBrandValue(parsedUrl.hostname, name);
  return parsedUrl;
};

const validateHomepage = (rawUrl) => {
  const homepage = parseAihubExternalUrl(rawUrl, 'AIHUB_DESKTOP_HOMEPAGE');

  if (homepage.protocol !== 'https:' || homepage.username || homepage.password) {
    throw new Error('AIHUB_DESKTOP_HOMEPAGE must be a credential-free HTTPS URL');
  }

  return homepage.toString();
};

const validateMaintainer = (maintainer) => {
  rejectLobehubExternalBrandValue(maintainer, 'AIHUB_DESKTOP_MAINTAINER');

  if (maintainer.length > 200 || /[\r\n]/.test(maintainer)) {
    throw new Error('AIHUB_DESKTOP_MAINTAINER must be a single line of at most 200 characters');
  }
  return maintainer;
};

export const applyAihubPackageMetadata = ({ homepage, packageMetadata }) => ({
  ...packageMetadata,
  description: AIHUB_DESKTOP_DESCRIPTION,
  homepage: validateHomepage(homepage),
  productName: AIHUB_PRODUCT_NAME,
});

const validateSigningEnvironment = (env, platform) => {
  if (env.AIHUB_REQUIRE_SIGNING !== '1') return;

  const requiredNames =
    platform === 'darwin'
      ? ['APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_TEAM_ID', 'CSC_KEY_PASSWORD', 'CSC_LINK']
      : platform === 'win32'
        ? ['CSC_KEY_PASSWORD', 'CSC_LINK']
        : [];

  for (const name of requiredNames) getRequiredEnv(env, name);
};

export const resolveDesktopBranding = ({
  env = process.env,
  fileExists = existsSync,
  platform = process.platform,
} = {}) => {
  const requestedBrand = env.DESKTOP_BRAND?.trim();

  if (!requestedBrand || requestedBrand === 'lobehub') {
    return {
      appId: 'com.lobehub.lobehub-desktop',
      brand: 'lobehub',
      isAIHub: false,
      productName: undefined,
    };
  }

  if (requestedBrand !== AIHUB_DESKTOP_BRAND) {
    throw new Error(`Unsupported DESKTOP_BRAND: ${requestedBrand}`);
  }

  if (env.UPDATE_CHANNEL !== 'stable') {
    throw new Error('AIHub desktop builds only support the isolated stable channel');
  }

  const appId = getRequiredEnv(env, 'AIHUB_DESKTOP_APP_ID');
  validateAppId(appId);
  const homepage = validateHomepage(getRequiredEnv(env, 'AIHUB_DESKTOP_HOMEPAGE'));
  const maintainer = validateMaintainer(getRequiredEnv(env, 'AIHUB_DESKTOP_MAINTAINER'));

  const assetsDirectory = path.resolve(getRequiredEnv(env, 'AIHUB_DESKTOP_ASSETS_DIR'));
  const icons = {
    icns: path.join(assetsDirectory, 'Icon.icns'),
    ico: path.join(assetsDirectory, 'icon.ico'),
    png: path.join(assetsDirectory, 'icon.png'),
  };

  for (const iconPath of Object.values(icons)) {
    if (!fileExists(iconPath)) {
      throw new Error(`Required AIHub desktop icon is missing: ${path.basename(iconPath)}`);
    }
  }

  validateSigningEnvironment(env, platform);

  return {
    appId,
    assetsDirectory,
    brand: AIHUB_DESKTOP_BRAND,
    description: AIHUB_DESKTOP_DESCRIPTION,
    homepage,
    icons,
    isAIHub: true,
    maintainer,
    productName: AIHUB_PRODUCT_NAME,
    updateServerUrl: validateUpdateServerUrl(getRequiredEnv(env, 'UPDATE_SERVER_URL')),
  };
};

export const validateDesktopIcon = ({ buffer, expectedDigest, format }) => {
  if (buffer.length < MIN_ICON_BYTES || buffer.length > MAX_ICON_BYTES) {
    throw new Error(
      `${format} icon size must be between ${MIN_ICON_BYTES} and ${MAX_ICON_BYTES} bytes`,
    );
  }

  const digest = expectedDigest.trim().toLowerCase();
  if (!/^[a-f\d]{64}$/.test(digest)) {
    throw new Error(`${format} icon SHA-256 must be a 64-character hexadecimal digest`);
  }

  const actualDigest = createHash('sha256').update(buffer).digest('hex');
  if (actualDigest !== digest) throw new Error(`${format} icon SHA-256 does not match`);

  const hasExpectedHeader =
    format === 'png'
      ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : format === 'icns'
        ? buffer.subarray(0, 4).toString('ascii') === 'icns' &&
          buffer.readUInt32BE(4) === buffer.length
        : buffer.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])) && buffer.readUInt16LE(4) > 0;

  if (!hasExpectedHeader) throw new Error(`${format} icon has an invalid file signature`);
};

export const materializeDesktopBrandAssets = async ({
  directory,
  env = process.env,
  sourceDirectory,
}) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });

  for (const definition of ICON_DEFINITIONS) {
    const expectedDigest = getRequiredEnv(env, definition.digestEnv);
    const buffer = await readFile(path.join(sourceDirectory, definition.fileName));

    validateDesktopIcon({ buffer, expectedDigest, format: definition.format });
    await writeFile(path.join(directory, definition.fileName), buffer, { mode: 0o600 });
  }
};
