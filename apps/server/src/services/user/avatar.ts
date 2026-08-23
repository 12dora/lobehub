import { createFileS3 } from '@/server/modules/S3';

const AVATAR_WEBAPI_PREFIX = '/webapi/';

interface UploadUserAvatarParams {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  oldAvatarUrl?: string | null;
  userId: string;
}

const getAvatarFilePath = (userId: string, fileName: string) => `user/avatar/${userId}/${fileName}`;

const getAvatarWebapiUrl = (filePath: string) => `${AVATAR_WEBAPI_PREFIX}${filePath}`;

/**
 * Locate an already-stored avatar object by its file-name prefix. Provider avatars use a
 * deterministic name, so this answers "did we already copy this exact source URL?" with one LIST
 * instead of re-downloading it on every login.
 */
export const findUserAvatarByPrefix = async (
  userId: string,
  fileNamePrefix: string,
): Promise<string | undefined> => {
  const s3 = await createFileS3();
  const keys = await s3.listObjectKeysByPrefix(getAvatarFilePath(userId, fileNamePrefix));
  const key = keys.at(0);
  return key ? getAvatarWebapiUrl(key) : undefined;
};

/**
 * Drop every stored avatar under `fileNamePrefix` except the one at `keepUrl`. A provider that
 * rotates its avatar URL would otherwise leave one orphaned object behind per login.
 */
export const pruneUserAvatars = async (
  userId: string,
  fileNamePrefix: string,
  keepUrl: string,
): Promise<void> => {
  const s3 = await createFileS3();
  const keys = await s3.listObjectKeysByPrefix(getAvatarFilePath(userId, fileNamePrefix));
  const stale = keys.filter((key) => getAvatarWebapiUrl(key) !== keepUrl);
  if (stale.length > 0) await s3.deleteFiles(stale);
};

export const uploadUserAvatar = async ({
  buffer,
  fileName,
  mimeType,
  oldAvatarUrl,
  userId,
}: UploadUserAvatarParams): Promise<string> => {
  const s3 = await createFileS3();
  const filePath = getAvatarFilePath(userId, fileName);

  await s3.uploadBuffer(filePath, buffer, mimeType);

  // Defense in depth: only remove objects inside this user's avatar prefix.
  const ownAvatarWebapiPrefix = getAvatarWebapiUrl(getAvatarFilePath(userId, ''));
  if (
    oldAvatarUrl &&
    oldAvatarUrl.startsWith(ownAvatarWebapiPrefix) &&
    !oldAvatarUrl.includes('..')
  ) {
    const oldFilePath = oldAvatarUrl.slice(AVATAR_WEBAPI_PREFIX.length);
    await s3.deleteFile(oldFilePath);
  }

  return getAvatarWebapiUrl(filePath);
};
