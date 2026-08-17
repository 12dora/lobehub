import type { EnterpriseCacheDomain } from '@lobechat/observability-otel/modules/enterprise-platform';

import {
  INFRA_SETTINGS_ID_MAIL,
  INFRA_SETTINGS_ID_OBJECT_STORAGE,
  INFRA_SETTINGS_INVALIDATION_SCOPE,
  INFRA_SETTINGS_LIMITS,
} from '@/const/platform/infraSettings';
import { getServerDB } from '@/database/core/db-adaptor';
import { InfraSettingsModel } from '@/database/models/platform/infraSettings';
import { fileEnv } from '@/envs/file';
import type { ResolvedFileS3Config } from '@/server/modules/S3/resolveFileS3Config';
import { resolveFileS3Config } from '@/server/modules/S3/resolveFileS3Config';
import type { MailPersisted, ObjectStoragePersisted } from '@/types/platform/infraSettings';
import { normalizeMailConfig, normalizeObjectStorageConfig } from '@/types/platform/infraSettings';

import { DomainConfigCache, invalidateDomainConfigCacheNamespace } from '../../runtimeConfig';
import {
  getPlatformConfigInvalidationPublisher,
  getPlatformConfigScopeVersion,
} from '../platformConfigInvalidation';
import type { InfraEnvBag, ResolvedEmailConfig } from '../platformSystem/infraDependencyConfig';
import { resolveEmailConfig } from '../platformSystem/infraDependencyConfig';
import { dbPreviewUrlExpireIn } from './destinationTuple';
import { envPreviewUrlExpireIn, resolveInfraEnvBag } from './envBag';
import { openInfraSecret } from './secrets';

export type InfraConfigSource = 'db' | 'env';

export type InfraObjectStorageSnapshot = ResolvedFileS3Config & {
  previewUrlExpireIn: number;
  source: InfraConfigSource;
};

export type InfraMailSnapshot = ResolvedEmailConfig & {
  source: InfraConfigSource;
};

export interface InfraRuntimeSnapshot {
  /**
   * Non-secret identity of the effective bags + row revisions.
   * Memoized S3 clients key on this and recreate when it changes.
   */
  fingerprint: string;
  loadedAt: number;
  mail: InfraMailSnapshot;
  mailRevision: number;
  objectStorage: InfraObjectStorageSnapshot;
  objectStorageRevision: number;
}

const CACHE_NAMESPACE = 'infra_settings';
const CACHE_ID = 'settings';
const cacheKey = {};
const OBSERVABILITY_DOMAIN = 'infra_settings' as EnterpriseCacheDomain;

const awsEndpointForRegion = (region: string): string => `https://s3.${region}.amazonaws.com`;

const objectStorageToEnvBag = (
  config: ObjectStoragePersisted,
  secretAccessKey: string | undefined,
): InfraEnvBag => ({
  S3_ACCESS_KEY_ID: config.accessKeyId,
  S3_BUCKET: config.bucket,
  S3_ENABLE_PATH_STYLE: config.forcePathStyle ? '1' : undefined,
  S3_ENDPOINT: config.endpoint ?? (config.region ? awsEndpointForRegion(config.region) : undefined),
  S3_PREVIEW_URL_EXPIRE_IN:
    config.previewUrlExpireIn === undefined ? undefined : String(config.previewUrlExpireIn),
  S3_PUBLIC_DOMAIN: config.publicDomain,
  S3_REGION: config.region,
  S3_SECRET_ACCESS_KEY: secretAccessKey,
  S3_SET_ACL: config.setAcl ? '1' : undefined,
});

const mailToEnvBag = (
  config: MailPersisted,
  secrets: { apiKey?: string; pass?: string },
): InfraEnvBag => {
  const from = config.senderName
    ? `"${config.senderName}" <${config.fromAddress}>`
    : config.fromAddress;
  if (config.provider === 'resend') {
    return {
      EMAIL_SERVICE_PROVIDER: 'resend',
      RESEND_API_KEY: secrets.apiKey,
      RESEND_FROM: from,
    };
  }
  return {
    EMAIL_SERVICE_PROVIDER: 'nodemailer',
    SMTP_FROM: from,
    SMTP_HOST: config.smtp?.host,
    SMTP_PASS: secrets.pass,
    SMTP_PORT: config.smtp ? String(config.smtp.port) : undefined,
    SMTP_SECURE: config.smtp?.secure ? 'true' : undefined,
    SMTP_USER: config.smtp?.user,
  };
};

const envObjectStorageSnapshot = (env: InfraEnvBag): InfraObjectStorageSnapshot => ({
  ...resolveFileS3Config(env),
  previewUrlExpireIn: envPreviewUrlExpireIn(env),
  source: 'env',
});

const envMailSnapshot = (env: InfraEnvBag): InfraMailSnapshot => ({
  ...resolveEmailConfig(env),
  source: 'env',
});

const fingerprintOf = (snapshot: Omit<InfraRuntimeSnapshot, 'fingerprint'>): string => {
  const storage =
    snapshot.objectStorage.kind === 'complete'
      ? {
          accessKeyId: snapshot.objectStorage.accessKeyId,
          bucket: snapshot.objectStorage.bucket,
          endpoint: snapshot.objectStorage.endpoint,
          forcePathStyle: snapshot.objectStorage.forcePathStyle,
          kind: snapshot.objectStorage.kind,
          previewUrlExpireIn: snapshot.objectStorage.previewUrlExpireIn,
          publicDomain: snapshot.objectStorage.publicDomain,
          region: snapshot.objectStorage.region,
          setAcl: snapshot.objectStorage.setAcl,
          source: snapshot.objectStorage.source,
        }
      : { kind: snapshot.objectStorage.kind, source: snapshot.objectStorage.source };
  const mail =
    snapshot.mail.kind === 'smtp'
      ? {
          host: snapshot.mail.host,
          kind: snapshot.mail.kind,
          port: snapshot.mail.port,
          secure: snapshot.mail.secure,
          source: snapshot.mail.source,
          user: snapshot.mail.user,
        }
      : snapshot.mail.kind === 'resend'
        ? { kind: snapshot.mail.kind, source: snapshot.mail.source }
        : { kind: snapshot.mail.kind, source: snapshot.mail.source };
  return [
    snapshot.objectStorageRevision,
    snapshot.mailRevision,
    JSON.stringify(storage),
    JSON.stringify(mail),
  ].join('|');
};

const withFingerprint = (
  snapshot: Omit<InfraRuntimeSnapshot, 'fingerprint'>,
): InfraRuntimeSnapshot => ({
  ...snapshot,
  fingerprint: fingerprintOf(snapshot),
});

const defaultSnapshot = (): InfraRuntimeSnapshot => {
  const env = resolveInfraEnvBag();
  return withFingerprint({
    loadedAt: Date.now(),
    mail: envMailSnapshot(env),
    mailRevision: 0,
    objectStorage: envObjectStorageSnapshot(env),
    objectStorageRevision: 0,
  });
};

const cloneSnapshot = (snapshot: InfraRuntimeSnapshot): InfraRuntimeSnapshot =>
  structuredClone(snapshot);

const openSecretOrUndefined = async (
  ciphertext: string | undefined,
): Promise<string | undefined> => {
  if (!ciphertext) return undefined;
  return openInfraSecret(ciphertext);
};

/**
 * Fail-open order on DB / decrypt error: last-known-good snapshot → env.
 * A DB outage must not flip live S3/mail back to env and break uploads.
 * We log once per process with the LKG age so operators can see staleness.
 */
let warnedFailOpen = false;
const warnFailOpen = (error: unknown, lkg: InfraRuntimeSnapshot | null): void => {
  if (warnedFailOpen) return;
  warnedFailOpen = true;
  console.warn('[infra-settings] load failed; serving last-known-good or env fallback', {
    errorClass: error instanceof Error ? error.name : 'UnknownError',
    fallback: lkg ? 'last-known-good' : 'env',
    lastKnownGoodAgeMs: lkg ? Date.now() - lkg.loadedAt : null,
  });
};

const resolveObjectStorage = async (
  raw: unknown,
  env: InfraEnvBag,
): Promise<InfraObjectStorageSnapshot> => {
  const config = normalizeObjectStorageConfig(raw);
  if (!config.enabled) return envObjectStorageSnapshot(env);
  try {
    const secretAccessKey = await openSecretOrUndefined(config.secretAccessKeyCiphertext);
    const resolved = resolveFileS3Config(objectStorageToEnvBag(config, secretAccessKey));
    return {
      ...resolved,
      // All-or-nothing: an enabled DB card must not inherit env preview expiry.
      previewUrlExpireIn: dbPreviewUrlExpireIn(config.previewUrlExpireIn),
      source: 'db',
    };
  } catch (error) {
    warnFailOpen(error, lastLoaded);
    return envObjectStorageSnapshot(env);
  }
};

const resolveMail = async (raw: unknown, env: InfraEnvBag): Promise<InfraMailSnapshot> => {
  const config = normalizeMailConfig(raw);
  if (!config.enabled) return envMailSnapshot(env);
  try {
    const [pass, apiKey] = await Promise.all([
      openSecretOrUndefined(config.smtp?.passCiphertext),
      openSecretOrUndefined(config.resend?.apiKeyCiphertext),
    ]);
    return {
      ...resolveEmailConfig(mailToEnvBag(config, { apiKey, pass })),
      source: 'db',
    };
  } catch (error) {
    warnFailOpen(error, lastLoaded);
    return envMailSnapshot(env);
  }
};

let cache: DomainConfigCache<InfraRuntimeSnapshot> | null = null;
let lastLoaded: InfraRuntimeSnapshot | null = null;

const loadSnapshot = async (): Promise<InfraRuntimeSnapshot> => {
  const db = await getServerDB();
  const model = new InfraSettingsModel(db);
  const [storageRow, mailRow] = await Promise.all([
    model.ensureDefault(INFRA_SETTINGS_ID_OBJECT_STORAGE),
    model.ensureDefault(INFRA_SETTINGS_ID_MAIL),
  ]);
  const env = resolveInfraEnvBag();
  const snapshot = withFingerprint({
    loadedAt: Date.now(),
    mail: await resolveMail(mailRow.config, env),
    mailRevision: mailRow.revision,
    objectStorage: await resolveObjectStorage(storageRow.config, env),
    objectStorageRevision: storageRow.revision,
  });
  lastLoaded = snapshot;
  return snapshot;
};

const cacheFor = (): DomainConfigCache<InfraRuntimeSnapshot> => {
  if (cache) return cache;
  cache = new DomainConfigCache<InfraRuntimeSnapshot>({
    cacheId: CACHE_ID,
    cacheKey,
    cacheTtlMs: INFRA_SETTINGS_LIMITS.SNAPSHOT_TTL_MS,
    cloneValue: cloneSnapshot,
    getScopeEpoch: () => getPlatformConfigScopeVersion(INFRA_SETTINGS_INVALIDATION_SCOPE),
    load: async () => {
      try {
        return await loadSnapshot();
      } catch (error) {
        warnFailOpen(error, lastLoaded);
        const fallback = lastLoaded ?? defaultSnapshot();
        lastLoaded = fallback;
        return fallback;
      }
    },
    namespace: CACHE_NAMESPACE,
    observabilityDomain: OBSERVABILITY_DOMAIN,
    onEntryStored: (value) => {
      if (value) lastLoaded = value;
    },
  });
  return cache;
};

export const getInfraSnapshot = async (): Promise<InfraRuntimeSnapshot> => {
  try {
    const snapshot = await cacheFor().get();
    const resolved = snapshot ?? lastLoaded ?? defaultSnapshot();
    lastLoaded = resolved;
    return cloneSnapshot(resolved);
  } catch (error) {
    warnFailOpen(error, lastLoaded);
    const fallback = lastLoaded ?? defaultSnapshot();
    lastLoaded = fallback;
    return cloneSnapshot(fallback);
  }
};

export const peekInfraSnapshot = (): InfraRuntimeSnapshot | null =>
  lastLoaded ? cloneSnapshot(lastLoaded) : null;

export const invalidateInfraSnapshot = (): void => {
  cache?.invalidate();
  invalidateDomainConfigCacheNamespace(CACHE_NAMESPACE);
};

export const publishInfraInvalidation = async (revision: number): Promise<void> => {
  await getPlatformConfigInvalidationPublisher().publish({
    at: new Date().toISOString(),
    resourceId: INFRA_SETTINGS_ID_OBJECT_STORAGE,
    resourceType: 'infra_settings',
    revision,
    scopes: [INFRA_SETTINGS_INVALIDATION_SCOPE],
  });
  invalidateInfraSnapshot();
};

export const resetInfraSnapshotForTest = (): void => {
  cache = null;
  lastLoaded = null;
  warnedFailOpen = false;
};

export const objectStorageSnapshotToEnvBag = (
  snapshot: InfraObjectStorageSnapshot,
): InfraEnvBag => {
  if (snapshot.kind !== 'complete') {
    return {
      S3_PREVIEW_URL_EXPIRE_IN: String(snapshot.previewUrlExpireIn),
    };
  }
  return {
    S3_ACCESS_KEY_ID: snapshot.accessKeyId,
    S3_BUCKET: snapshot.bucket,
    S3_ENABLE_PATH_STYLE: snapshot.forcePathStyle ? '1' : undefined,
    S3_ENDPOINT: snapshot.endpoint,
    S3_PREVIEW_URL_EXPIRE_IN: String(snapshot.previewUrlExpireIn),
    S3_PUBLIC_DOMAIN: snapshot.publicDomain,
    S3_REGION: snapshot.region,
    S3_SECRET_ACCESS_KEY: snapshot.secretAccessKey,
    S3_SET_ACL: snapshot.setAcl ? '1' : undefined,
  };
};

export const mailSnapshotToEnvBag = (snapshot: InfraMailSnapshot): InfraEnvBag => {
  if (snapshot.kind === 'resend') {
    return {
      EMAIL_SERVICE_PROVIDER: 'resend',
      RESEND_API_KEY: snapshot.apiKey,
      RESEND_FROM: snapshot.senderName
        ? `"${snapshot.senderName}" <${snapshot.from}>`
        : snapshot.from,
    };
  }
  if (snapshot.kind === 'smtp') {
    return {
      EMAIL_SERVICE_PROVIDER: 'nodemailer',
      SMTP_FROM: snapshot.senderName
        ? `"${snapshot.senderName}" <${snapshot.from}>`
        : snapshot.from,
      SMTP_HOST: snapshot.host,
      SMTP_PASS: snapshot.pass,
      SMTP_PORT: String(snapshot.port),
      SMTP_SECURE: snapshot.secure ? 'true' : undefined,
      SMTP_USER: snapshot.user,
    };
  }
  if (snapshot.kind === 'incomplete') {
    return {
      EMAIL_SERVICE_PROVIDER: snapshot.provider === 'resend' ? 'resend' : 'nodemailer',
    };
  }
  return {};
};

/** Used by audit-export / branding gates that cannot always await. */
export const isObjectStorageConfiguredFromEnv = (): boolean =>
  Boolean(fileEnv.S3_BUCKET && (fileEnv.S3_ENDPOINT || fileEnv.S3_REGION));
