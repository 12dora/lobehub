import type { ObjectStoragePersisted, ObjectStorageUpdate } from '@/types/platform/infraSettings';
import { createDefaultObjectStorageConfig } from '@/types/platform/infraSettings';

import { objectStorageDestinationTuple, objectStorageTuplesEqual } from './destinationTuple';
import { InfraSettingsSecretRequiredError } from './errors';
import { resolveInfraSecretCiphertext } from './resolveSecretAction';

async function resolveObjectStorageSecretCiphertext(
  stored: ObjectStoragePersisted,
  update: ObjectStorageUpdate,
): Promise<string | undefined> {
  return resolveInfraSecretCiphertext({
    action: update.secretAccessKey,
    field: 'secretAccessKey',
    reuse: update.enabled
      ? {
          destinationUnchanged: objectStorageTuplesEqual(
            objectStorageDestinationTuple(stored),
            objectStorageDestinationTuple({
              bucket: update.bucket ?? stored.bucket,
              endpoint: update.endpoint ?? stored.endpoint,
              region: update.region ?? stored.region,
            }),
          ),
        }
      : undefined,
    storedCiphertext: stored.secretAccessKeyCiphertext,
  });
}

function applyDisabledObjectStorageUpdate(
  stored: ObjectStoragePersisted,
  update: ObjectStorageUpdate,
  secretAccessKeyCiphertext: string | undefined,
): ObjectStoragePersisted {
  const next: ObjectStoragePersisted = {
    enabled: false,
    forcePathStyle: update.forcePathStyle ?? stored.forcePathStyle,
    setAcl: update.setAcl ?? stored.setAcl,
  };
  const accessKeyId = update.accessKeyId ?? stored.accessKeyId;
  const bucket = update.bucket ?? stored.bucket;
  const endpoint = update.endpoint ?? stored.endpoint;
  const region = update.region ?? stored.region;
  const publicDomain = update.publicDomain ?? stored.publicDomain;
  const previewUrlExpireIn =
    update.previewUrlExpireIn !== undefined ? update.previewUrlExpireIn : stored.previewUrlExpireIn;
  if (accessKeyId) next.accessKeyId = accessKeyId;
  if (bucket) next.bucket = bucket;
  if (endpoint) next.endpoint = endpoint;
  if (region) next.region = region;
  if (publicDomain) next.publicDomain = publicDomain;
  if (previewUrlExpireIn !== undefined) next.previewUrlExpireIn = previewUrlExpireIn;
  if (secretAccessKeyCiphertext) next.secretAccessKeyCiphertext = secretAccessKeyCiphertext;
  return next;
}

function applyEnabledObjectStorageUpdate(
  stored: ObjectStoragePersisted,
  update: ObjectStorageUpdate,
  secretAccessKeyCiphertext: string | undefined,
): ObjectStoragePersisted {
  const next: ObjectStoragePersisted = {
    accessKeyId: update.accessKeyId,
    bucket: update.bucket,
    enabled: true,
    forcePathStyle: update.forcePathStyle ?? stored.forcePathStyle,
    setAcl: update.setAcl ?? stored.setAcl,
  };
  if (update.endpoint) next.endpoint = update.endpoint;
  if (update.region) next.region = update.region;
  if (update.publicDomain) next.publicDomain = update.publicDomain;
  if (update.previewUrlExpireIn !== undefined) next.previewUrlExpireIn = update.previewUrlExpireIn;
  if (secretAccessKeyCiphertext) next.secretAccessKeyCiphertext = secretAccessKeyCiphertext;
  return next;
}

export async function applyObjectStorageUpdate(
  current: ObjectStoragePersisted | undefined,
  update: ObjectStorageUpdate,
): Promise<ObjectStoragePersisted> {
  const stored = current ?? createDefaultObjectStorageConfig();
  const secretAccessKeyCiphertext = await resolveObjectStorageSecretCiphertext(stored, update);

  if (update.enabled && !secretAccessKeyCiphertext) {
    throw new InfraSettingsSecretRequiredError('secretAccessKey');
  }

  if (!update.enabled) {
    return applyDisabledObjectStorageUpdate(stored, update, secretAccessKeyCiphertext);
  }

  return applyEnabledObjectStorageUpdate(stored, update, secretAccessKeyCiphertext);
}
