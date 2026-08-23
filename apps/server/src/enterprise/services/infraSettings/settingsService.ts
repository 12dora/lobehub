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
  normalizeMailConfig,
  normalizeObjectStorageConfig,
} from '@/types/platform/infraSettings';

import { maskAccessId } from '../platformSystem/infraDependencyConfig';
import {
  assertMailDestinationsAllowed,
  assertObjectStorageDestinationsAllowed,
} from './destinationPolicy';
import { mailDestinationTuple, mailTuplesEqual } from './destinationTuple';
import { InfraSettingsSecretRequiredError } from './errors';
import { applyObjectStorageUpdate } from './objectStorageUpdate';
import { resolveInfraSecretCiphertext } from './resolveSecretAction';

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

export { applyObjectStorageUpdate };

const buildMailSmtp = (
  stored: MailPersisted,
  smtpUpdate: MailUpdate['smtp'] | undefined,
  passCiphertext: string | undefined,
): NonNullable<MailPersisted['smtp']> => {
  const smtp: NonNullable<MailPersisted['smtp']> = {
    host: smtpUpdate?.host ?? stored.smtp?.host ?? '',
    port: smtpUpdate?.port ?? stored.smtp?.port ?? 587,
    secure: smtpUpdate?.secure ?? stored.smtp?.secure ?? false,
    user: smtpUpdate?.user ?? stored.smtp?.user ?? '',
  };
  if (passCiphertext) smtp.passCiphertext = passCiphertext;
  return smtp;
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
      const passCiphertext = await resolveInfraSecretCiphertext({
        action: update.smtp?.pass,
        field: 'pass',
        storedCiphertext: stored.smtp?.passCiphertext,
      });
      next.smtp = buildMailSmtp(stored, update.smtp, passCiphertext);
    }

    if (stored.resend || update.resend) {
      const apiKeyCiphertext = await resolveInfraSecretCiphertext({
        action: update.resend?.apiKey,
        field: 'apiKey',
        storedCiphertext: stored.resend?.apiKeyCiphertext,
      });
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
    const passCiphertext = await resolveInfraSecretCiphertext({
      action: smtp.pass,
      field: 'pass',
      reuse: {
        destinationUnchanged: mailTuplesEqual(
          mailDestinationTuple({
            provider: stored.provider,
            smtp: stored.smtp,
          }),
          mailDestinationTuple({ provider: 'smtp', smtp }),
        ),
      },
      storedCiphertext: stored.smtp?.passCiphertext,
    });
    if (!passCiphertext) {
      throw new InfraSettingsSecretRequiredError('smtp.pass');
    }
    next.smtp = buildMailSmtp(stored, smtp, passCiphertext);
  } else {
    const resend = update.resend!;
    const apiKeyCiphertext = await resolveInfraSecretCiphertext({
      action: resend.apiKey,
      field: 'apiKey',
      reuse: {
        destinationUnchanged: mailTuplesEqual(
          mailDestinationTuple({
            provider: stored.provider,
            smtp: stored.smtp,
          }),
          mailDestinationTuple({ provider: 'resend' }),
        ),
      },
      storedCiphertext: stored.resend?.apiKeyCiphertext,
    });
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
