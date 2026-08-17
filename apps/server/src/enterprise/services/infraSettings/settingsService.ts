import {
  INFRA_SETTINGS_ID_MAIL,
  INFRA_SETTINGS_ID_OBJECT_STORAGE,
} from '@/const/platform/infraSettings';
import { InfraSettingsModel } from '@/database/models/platform/infraSettings';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type {
  MailPersisted,
  MailUpdate,
  MailView,
  ObjectStoragePersisted,
  ObjectStorageUpdate,
  ObjectStorageView,
} from '@/types/platform/infraSettings';
import {
  createDefaultMailConfig,
  createDefaultObjectStorageConfig,
  normalizeMailConfig,
  normalizeObjectStorageConfig,
} from '@/types/platform/infraSettings';

import { maskAccessId } from '../platformSystem/infraDependencyConfig';
import {
  assertMailDestinationsAllowed,
  assertObjectStorageDestinationsAllowed,
} from './destinationPolicy';
import {
  INFRA_SECRET_REUSE_MESSAGE,
  mailDestinationTuple,
  mailTuplesEqual,
  objectStorageDestinationTuple,
  objectStorageTuplesEqual,
} from './destinationTuple';
import { InfraSettingsSecretRequiredError, InfraSettingsSecretReuseError } from './errors';
import { sealInfraSecret } from './secrets';

export interface InfraSettingsServiceRow<T> {
  config: T;
  revision: number;
  updatedAt: Date | null;
}

const toStorageRow = (row: {
  config: unknown;
  revision: number;
  updatedAt: Date | null;
}): InfraSettingsServiceRow<ObjectStoragePersisted> => ({
  config: normalizeObjectStorageConfig(row.config),
  revision: row.revision,
  updatedAt: row.updatedAt,
});

const toMailRow = (row: {
  config: unknown;
  revision: number;
  updatedAt: Date | null;
}): InfraSettingsServiceRow<MailPersisted> => ({
  config: normalizeMailConfig(row.config),
  revision: row.revision,
  updatedAt: row.updatedAt,
});

export const getObjectStorageSettings = async (
  db: LobeChatDatabase | Transaction,
): Promise<InfraSettingsServiceRow<ObjectStoragePersisted>> => {
  const row = await new InfraSettingsModel(db).ensureDefault(INFRA_SETTINGS_ID_OBJECT_STORAGE);
  return toStorageRow(row);
};

export const getMailSettings = async (
  db: LobeChatDatabase | Transaction,
): Promise<InfraSettingsServiceRow<MailPersisted>> => {
  const row = await new InfraSettingsModel(db).ensureDefault(INFRA_SETTINGS_ID_MAIL);
  return toMailRow(row);
};

const KEEP_SECRET = { action: 'keep' as const };

export const applyObjectStorageUpdate = async (
  current: ObjectStoragePersisted | undefined,
  update: ObjectStorageUpdate,
): Promise<ObjectStoragePersisted> => {
  const stored = current ?? createDefaultObjectStorageConfig();
  const secretAction = update.secretAccessKey ?? KEEP_SECRET;
  let secretAccessKeyCiphertext = stored.secretAccessKeyCiphertext;

  if (secretAction.action === 'clear') {
    secretAccessKeyCiphertext = undefined;
  } else if (secretAction.action === 'replace') {
    secretAccessKeyCiphertext = await sealInfraSecret(secretAction.value);
  } else if (secretAction.action === 'keep' && secretAccessKeyCiphertext && update.enabled) {
    const storedTuple = objectStorageDestinationTuple(stored);
    const nextTuple = objectStorageDestinationTuple({
      bucket: update.bucket ?? stored.bucket,
      endpoint: update.endpoint ?? stored.endpoint,
      region: update.region ?? stored.region,
    });
    if (!objectStorageTuplesEqual(storedTuple, nextTuple)) {
      throw new InfraSettingsSecretReuseError('secretAccessKey', INFRA_SECRET_REUSE_MESSAGE);
    }
  }

  if (update.enabled && !secretAccessKeyCiphertext) {
    throw new InfraSettingsSecretRequiredError('secretAccessKey');
  }

  if (!update.enabled) {
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
      update.previewUrlExpireIn !== undefined
        ? update.previewUrlExpireIn
        : stored.previewUrlExpireIn;
    if (accessKeyId) next.accessKeyId = accessKeyId;
    if (bucket) next.bucket = bucket;
    if (endpoint) next.endpoint = endpoint;
    if (region) next.region = region;
    if (publicDomain) next.publicDomain = publicDomain;
    if (previewUrlExpireIn !== undefined) next.previewUrlExpireIn = previewUrlExpireIn;
    if (secretAccessKeyCiphertext) next.secretAccessKeyCiphertext = secretAccessKeyCiphertext;
    return next;
  }

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
};

export const applyMailUpdate = async (
  current: MailPersisted | undefined,
  update: MailUpdate,
): Promise<MailPersisted> => {
  const stored = current ?? createDefaultMailConfig();

  if (!update.enabled) {
    const next: MailPersisted = {
      enabled: false,
      fromAddress: update.fromAddress ?? stored.fromAddress,
      provider: update.provider ?? stored.provider,
    };
    const senderName = update.senderName ?? stored.senderName;
    if (senderName) next.senderName = senderName;

    if (stored.smtp || update.smtp) {
      const passAction = update.smtp?.pass ?? KEEP_SECRET;
      let passCiphertext = stored.smtp?.passCiphertext;
      if (passAction.action === 'clear') {
        passCiphertext = undefined;
      } else if (passAction.action === 'replace') {
        passCiphertext = await sealInfraSecret(passAction.value);
      }
      next.smtp = {
        host: update.smtp?.host ?? stored.smtp?.host ?? '',
        port: update.smtp?.port ?? stored.smtp?.port ?? 587,
        secure: update.smtp?.secure ?? stored.smtp?.secure ?? false,
        user: update.smtp?.user ?? stored.smtp?.user ?? '',
      };
      if (passCiphertext) next.smtp.passCiphertext = passCiphertext;
    }

    if (stored.resend || update.resend) {
      const keyAction = update.resend?.apiKey ?? KEEP_SECRET;
      let apiKeyCiphertext = stored.resend?.apiKeyCiphertext;
      if (keyAction.action === 'clear') {
        apiKeyCiphertext = undefined;
      } else if (keyAction.action === 'replace') {
        apiKeyCiphertext = await sealInfraSecret(keyAction.value);
      }
      next.resend = {};
      if (apiKeyCiphertext) next.resend.apiKeyCiphertext = apiKeyCiphertext;
    }

    return next;
  }

  const provider = update.provider ?? stored.provider;
  const next: MailPersisted = {
    enabled: true,
    fromAddress: update.fromAddress ?? stored.fromAddress,
    provider,
  };
  if (update.senderName) next.senderName = update.senderName;

  if (provider === 'smtp') {
    const smtp = update.smtp!;
    const passAction = smtp.pass ?? KEEP_SECRET;
    let passCiphertext = stored.smtp?.passCiphertext;
    if (passAction.action === 'clear') {
      passCiphertext = undefined;
    } else if (passAction.action === 'replace') {
      passCiphertext = await sealInfraSecret(passAction.value);
    } else if (passAction.action === 'keep' && passCiphertext) {
      const storedTuple = mailDestinationTuple({
        provider: stored.provider,
        smtp: stored.smtp,
      });
      const nextTuple = mailDestinationTuple({ provider: 'smtp', smtp });
      if (!mailTuplesEqual(storedTuple, nextTuple)) {
        throw new InfraSettingsSecretReuseError('pass', INFRA_SECRET_REUSE_MESSAGE);
      }
    }
    if (!passCiphertext) {
      throw new InfraSettingsSecretRequiredError('smtp.pass');
    }
    next.smtp = {
      host: smtp.host ?? stored.smtp?.host ?? '',
      port: smtp.port ?? stored.smtp?.port ?? 587,
      secure: smtp.secure ?? stored.smtp?.secure ?? false,
      user: smtp.user ?? stored.smtp?.user ?? '',
    };
    if (passCiphertext) next.smtp.passCiphertext = passCiphertext;
  } else {
    const resend = update.resend!;
    const keyAction = resend.apiKey ?? KEEP_SECRET;
    let apiKeyCiphertext = stored.resend?.apiKeyCiphertext;
    if (keyAction.action === 'clear') {
      apiKeyCiphertext = undefined;
    } else if (keyAction.action === 'replace') {
      apiKeyCiphertext = await sealInfraSecret(keyAction.value);
    } else if (keyAction.action === 'keep' && apiKeyCiphertext) {
      const storedTuple = mailDestinationTuple({
        provider: stored.provider,
        smtp: stored.smtp,
      });
      const nextTuple = mailDestinationTuple({ provider: 'resend' });
      if (!mailTuplesEqual(storedTuple, nextTuple)) {
        throw new InfraSettingsSecretReuseError('apiKey', INFRA_SECRET_REUSE_MESSAGE);
      }
    }
    if (!apiKeyCiphertext) {
      throw new InfraSettingsSecretRequiredError('resend.apiKey');
    }
    next.resend = {};
    if (apiKeyCiphertext) next.resend.apiKeyCiphertext = apiKeyCiphertext;
  }

  return next;
};

export const updateObjectStorageSettings = async (
  db: LobeChatDatabase | Transaction,
  input: { config: ObjectStorageUpdate; expectedRevision: number; updatedBy: string },
): Promise<InfraSettingsServiceRow<ObjectStoragePersisted>> => {
  const current = await getObjectStorageSettings(db);
  const config = await applyObjectStorageUpdate(current.config, input.config);
  if (config.enabled) {
    await assertObjectStorageDestinationsAllowed(config);
  }
  const row = await new InfraSettingsModel(db).update({
    config,
    expectedRevision: input.expectedRevision,
    id: INFRA_SETTINGS_ID_OBJECT_STORAGE,
    updatedBy: input.updatedBy,
  });
  return toStorageRow(row);
};

export const updateMailSettings = async (
  db: LobeChatDatabase | Transaction,
  input: { config: MailUpdate; expectedRevision: number; updatedBy: string },
): Promise<InfraSettingsServiceRow<MailPersisted>> => {
  const current = await getMailSettings(db);
  const config = await applyMailUpdate(current.config, input.config);
  if (config.enabled) {
    await assertMailDestinationsAllowed(config);
  }
  const row = await new InfraSettingsModel(db).update({
    config,
    expectedRevision: input.expectedRevision,
    id: INFRA_SETTINGS_ID_MAIL,
    updatedBy: input.updatedBy,
  });
  return toMailRow(row);
};

export const toObjectStorageView = (config: ObjectStoragePersisted): ObjectStorageView => {
  const { secretAccessKeyCiphertext, ...rest } = config;
  return { ...rest, hasSecretAccessKey: Boolean(secretAccessKeyCiphertext) };
};

export const toMailView = (config: MailPersisted): MailView => ({
  enabled: config.enabled,
  fromAddress: config.fromAddress,
  hasResendApiKey: Boolean(config.resend?.apiKeyCiphertext),
  hasSmtpPass: Boolean(config.smtp?.passCiphertext),
  provider: config.provider,
  ...(config.senderName ? { senderName: config.senderName } : {}),
  ...(config.smtp
    ? {
        smtp: {
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          user: config.smtp.user,
        },
      }
    : {}),
});

export const objectStorageSecretChanged = (
  previous: ObjectStoragePersisted | undefined,
  next: ObjectStoragePersisted,
): boolean => previous?.secretAccessKeyCiphertext !== next.secretAccessKeyCiphertext;

export const mailSecretChanged = (
  previous: MailPersisted | undefined,
  next: MailPersisted,
): boolean =>
  previous?.smtp?.passCiphertext !== next.smtp?.passCiphertext ||
  previous?.resend?.apiKeyCiphertext !== next.resend?.apiKeyCiphertext;

/** Redacted audit afterDiff — never includes plaintext or ciphertext. */
export const summarizeObjectStorageAfterDiff = (
  config: ObjectStoragePersisted,
  secretChanged: boolean,
) => ({
  accessKeyIdMasked: maskAccessId(config.accessKeyId),
  bucket: config.bucket ?? null,
  enabled: config.enabled,
  endpoint: config.endpoint ?? null,
  forcePathStyle: config.forcePathStyle,
  publicDomain: config.publicDomain ?? null,
  region: config.region ?? null,
  secretChanged,
  setAcl: config.setAcl,
});

export const summarizeMailAfterDiff = (config: MailPersisted, secretChanged: boolean) => ({
  enabled: config.enabled,
  fromAddress: config.fromAddress,
  host: config.smtp?.host ?? null,
  port: config.smtp?.port ?? null,
  provider: config.provider,
  secretChanged,
  secure: config.smtp?.secure ?? null,
  senderName: config.senderName ?? null,
  user: config.smtp?.user ?? null,
});

export const INFRA_SETTINGS_AUDIT_ACTIONS = {
  MAIL_UPDATE: 'system.infra.mail.update',
  OBJECT_STORAGE_UPDATE: 'system.infra.object_storage.update',
} as const;

export const INFRA_SETTINGS_AUDIT_TARGET_TYPE = 'infra_settings' as const;
