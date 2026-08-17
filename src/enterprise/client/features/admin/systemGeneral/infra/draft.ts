import type {
  InfraMailConfigInput,
  InfraMailView,
  InfraObjectStorageConfigInput,
  InfraObjectStorageView,
  InfraSecretAction,
} from './types';

/**
 * Draft state for a secret the server never returns.
 *
 * `stored` is server truth (a secret exists *in the database*), `value` is what the admin typed,
 * `cleared` is the explicit "remove it" toggle. Everything the UI and the update payload need is
 * derived from those three — see `deriveSecretAction`.
 */
export interface InfraSecretDraft {
  cleared: boolean;
  stored: boolean;
  value: string;
}

export interface ObjectStorageDraft {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  forcePathStyle: boolean;
  /** Free text so "unset" stays distinguishable from 0 while typing. */
  previewUrlExpireIn: string;
  publicDomain: string;
  region: string;
  secretAccessKey: InfraSecretDraft;
  setAcl: boolean;
}

export interface MailDraft {
  fromAddress: string;
  host: string;
  pass: InfraSecretDraft;
  port: string;
  provider: 'resend' | 'smtp';
  resendApiKey: InfraSecretDraft;
  secure: boolean;
  senderName: string;
  user: string;
}

export const MIN_PREVIEW_URL_EXPIRE_IN = 60;
export const MAX_PREVIEW_URL_EXPIRE_IN = 604_800;

const emptySecret = (stored: boolean): InfraSecretDraft => ({ cleared: false, stored, value: '' });

/**
 * A typed value always wins, then an explicit clear; otherwise keep whatever is stored.
 * When nothing is stored and nothing was typed the intent is still "keep" — validation blocks the
 * save before it reaches the server, which would reject an enabled config without a secret.
 */
export const deriveSecretAction = (secret: InfraSecretDraft): InfraSecretAction => {
  if (secret.value.length > 0) return { action: 'replace', value: secret.value };
  if (secret.cleared) return { action: 'clear' };
  return { action: 'keep' };
};

/** True when the config will have no secret after this draft is applied. */
export const secretMissing = (secret: InfraSecretDraft): boolean =>
  secret.value.length === 0 && (secret.cleared || !secret.stored);

/**
 * State of a secret right after a successful save: the plaintext is dropped from memory and
 * "stored" now reflects what the server holds.
 */
export const settleSecret = (secret: InfraSecretDraft): InfraSecretDraft => ({
  cleared: false,
  stored: !secretMissing(secret),
  value: '',
});

/**
 * Seed the editable form from the effective configuration.
 *
 * When the values come from the environment the secret is not the only unusable field: the access
 * key id is masked in that mode, so it is dropped as well and the admin re-enters both. A stored
 * secret only counts when the database owns the card — otherwise "keep" would refer to a secret
 * that does not exist in the database and the save would be rejected.
 */
export const toObjectStorageDraft = (view: InfraObjectStorageView): ObjectStorageDraft => {
  const fromDb = view.source === 'db';
  return {
    // `accessId` is masked while the environment owns the card, so it is not reusable there.
    accessKeyId: fromDb ? (view.accessId ?? '') : '',
    bucket: view.bucket ?? '',
    endpoint: view.endpoint ?? '',
    forcePathStyle: view.pathStyle,
    previewUrlExpireIn: view.previewUrlExpireIn == null ? '' : String(view.previewUrlExpireIn),
    publicDomain: view.publicDomain ?? '',
    region: view.region ?? '',
    secretAccessKey: emptySecret(fromDb && view.hasSecretAccessKey),
    setAcl: view.setAcl,
  };
};

export const toMailDraft = (view: InfraMailView): MailDraft => {
  const fromDb = view.source === 'db';
  return {
    fromAddress: view.fromAddress ?? '',
    host: view.host ?? '',
    pass: emptySecret(fromDb && view.hasSmtpPass),
    port: view.port == null ? '' : String(view.port),
    provider: view.provider === 'resend' ? 'resend' : 'smtp',
    resendApiKey: emptySecret(fromDb && view.hasResendApiKey),
    secure: view.secure ?? false,
    senderName: view.senderName ?? '',
    user: view.smtpUser ?? '',
  };
};

const secretFingerprint = (secret: InfraSecretDraft): string =>
  `${secret.stored ? '1' : '0'}${secret.cleared ? 'c' : '-'}${secret.value.length > 0 ? 'v' : '-'}`;

export const fingerprintObjectStorageDraft = (draft: ObjectStorageDraft): string =>
  [
    draft.endpoint.trim(),
    draft.region.trim(),
    draft.bucket.trim(),
    draft.accessKeyId.trim(),
    draft.publicDomain.trim(),
    draft.previewUrlExpireIn.trim(),
    draft.forcePathStyle ? '1' : '0',
    draft.setAcl ? '1' : '0',
    secretFingerprint(draft.secretAccessKey),
  ].join('|');

export const fingerprintMailDraft = (draft: MailDraft): string =>
  [
    draft.provider,
    draft.fromAddress.trim(),
    draft.senderName.trim(),
    draft.host.trim(),
    draft.port.trim(),
    draft.user.trim(),
    draft.secure ? '1' : '0',
    secretFingerprint(draft.pass),
    secretFingerprint(draft.resendApiKey),
  ].join('|');

/** Field name → `systemGeneral.errors.*` key suffix. Empty object means "safe to submit". */
export type InfraFieldErrors = Record<string, string>;

/**
 * Mirrors `adminSystemObjectStorageConfigSchema` / `adminSystemMailConfigSchema`
 * (`apps/server/src/enterprise/contracts/adminSystem.ts`). The schemas themselves cannot be
 * imported here: the contract module pulls `security/redaction` → `@/database/models/platform/redact`,
 * i.e. server/database code that must not enter the browser bundle. So every constraint is mirrored
 * by hand and covered by tests — a normal input must never reach a server-only rejection.
 */
const MAX = {
  accessKeyId: 128,
  bucket: 255,
  fromAddress: 320,
  host: 255,
  region: 64,
  secret: 512,
  senderName: 256,
  url: 2048,
  user: 320,
};

/**
 * Fields that decide WHERE a stored credential is sent.
 *
 * Reusing `{action:'keep'}` after one of these changed would hand the existing secret to a new
 * destination, so the server rejects it and the form asks for the credential up front.
 */
const objectStorageDestination = (draft: ObjectStorageDraft): string =>
  [draft.endpoint.trim(), draft.region.trim(), draft.bucket.trim()].join('|');

const mailDestination = (draft: MailDraft): string =>
  [
    draft.provider,
    draft.host.trim(),
    draft.port.trim(),
    draft.secure ? '1' : '0',
    draft.user.trim(),
  ].join('|');

/** A kept secret is only valid while it keeps pointing at the destination it was stored for. */
const secretNeedsReentry = (secret: InfraSecretDraft, destinationChanged: boolean): boolean =>
  destinationChanged && deriveSecretAction(secret).action === 'keep' && secret.stored;

const secretTooLong = (secret: InfraSecretDraft): boolean => secret.value.length > MAX.secret;

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Deliberately permissive — the server owns the authoritative check (zod `.email()`). */
const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(value);

export const validateObjectStorageDraft = (
  draft: ObjectStorageDraft,
  /** Last saved draft — used to notice that the credential destination moved. */
  baseline?: ObjectStorageDraft,
): InfraFieldErrors => {
  const errors: InfraFieldErrors = {};
  const endpoint = draft.endpoint.trim();
  const region = draft.region.trim();
  const bucket = draft.bucket.trim();
  const accessKeyId = draft.accessKeyId.trim();
  const publicDomain = draft.publicDomain.trim();
  const expire = draft.previewUrlExpireIn.trim();

  if (endpoint.length === 0 && region.length === 0) errors.endpoint = 'endpointOrRegion';
  else if (endpoint.length > 0) {
    if (endpoint.length > MAX.url) errors.endpoint = 'tooLong';
    else if (!isHttpUrl(endpoint)) errors.endpoint = 'url';
  }
  if (region.length > MAX.region) errors.region = 'tooLong';
  if (bucket.length === 0) errors.bucket = 'required';
  else if (bucket.length > MAX.bucket) errors.bucket = 'tooLong';
  if (accessKeyId.length === 0) errors.accessKeyId = 'required';
  else if (accessKeyId.length > MAX.accessKeyId) errors.accessKeyId = 'tooLong';
  if (secretMissing(draft.secretAccessKey)) errors.secretAccessKey = 'secretRequired';
  else if (secretTooLong(draft.secretAccessKey)) errors.secretAccessKey = 'secretTooLong';
  else if (
    secretNeedsReentry(
      draft.secretAccessKey,
      Boolean(baseline) && objectStorageDestination(draft) !== objectStorageDestination(baseline!),
    )
  ) {
    errors.secretAccessKey = 'secretReenterRequired';
  }
  if (publicDomain.length > 0) {
    if (publicDomain.length > MAX.url) errors.publicDomain = 'tooLong';
    else if (!isHttpUrl(publicDomain)) errors.publicDomain = 'url';
  }
  if (expire.length > 0) {
    const parsed = Number(expire);
    if (
      !Number.isInteger(parsed) ||
      parsed < MIN_PREVIEW_URL_EXPIRE_IN ||
      parsed > MAX_PREVIEW_URL_EXPIRE_IN
    ) {
      errors.previewUrlExpireIn = 'previewExpire';
    }
  }
  return errors;
};

export const validateMailDraft = (
  draft: MailDraft,
  /** Last saved draft — used to notice that the credential destination moved. */
  baseline?: MailDraft,
): InfraFieldErrors => {
  const errors: InfraFieldErrors = {};
  const fromAddress = draft.fromAddress.trim();
  const destinationChanged =
    Boolean(baseline) && mailDestination(draft) !== mailDestination(baseline!);

  if (fromAddress.length === 0) errors.fromAddress = 'required';
  else if (fromAddress.length > MAX.fromAddress) errors.fromAddress = 'tooLong';
  else if (!isEmail(fromAddress)) errors.fromAddress = 'email';
  if (draft.senderName.trim().length > MAX.senderName) errors.senderName = 'tooLong';

  if (draft.provider === 'smtp') {
    const host = draft.host.trim();
    const user = draft.user.trim();
    const port = Number(draft.port.trim());
    if (host.length === 0) errors.host = 'required';
    else if (host.length > MAX.host) errors.host = 'tooLong';
    if (draft.port.trim().length === 0) errors.port = 'required';
    else if (!Number.isInteger(port) || port < 1 || port > 65_535) errors.port = 'port';
    if (user.length === 0) errors.user = 'required';
    else if (user.length > MAX.user) errors.user = 'tooLong';
    if (secretMissing(draft.pass)) errors.pass = 'secretRequired';
    else if (secretTooLong(draft.pass)) errors.pass = 'secretTooLong';
    else if (secretNeedsReentry(draft.pass, destinationChanged)) {
      errors.pass = 'secretReenterRequired';
    }
  } else if (secretMissing(draft.resendApiKey)) errors.resendApiKey = 'secretRequired';
  else if (secretTooLong(draft.resendApiKey)) errors.resendApiKey = 'secretTooLong';
  else if (secretNeedsReentry(draft.resendApiKey, destinationChanged)) {
    errors.resendApiKey = 'secretReenterRequired';
  }

  return errors;
};

/** Errors an admin must act on before the write is even attempted. */
export const INFRA_BLOCKING_ERROR_KEYS: ReadonlySet<string> = new Set(['secretReenterRequired']);

const optionalText = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const toObjectStorageConfig = (draft: ObjectStorageDraft): InfraObjectStorageConfigInput => {
  const expire = draft.previewUrlExpireIn.trim();
  return {
    accessKeyId: draft.accessKeyId.trim(),
    bucket: draft.bucket.trim(),
    enabled: true,
    forcePathStyle: draft.forcePathStyle,
    secretAccessKey: deriveSecretAction(draft.secretAccessKey),
    setAcl: draft.setAcl,
    ...(optionalText(draft.endpoint) ? { endpoint: draft.endpoint.trim() } : {}),
    ...(optionalText(draft.region) ? { region: draft.region.trim() } : {}),
    ...(optionalText(draft.publicDomain) ? { publicDomain: draft.publicDomain.trim() } : {}),
    ...(expire.length > 0 ? { previewUrlExpireIn: Number(expire) } : {}),
  };
};

/**
 * Payload for 恢复为环境变量.
 *
 * Switching the override off must never be blocked by the configuration it is switching off: in the
 * fail-open state (saved override present but undecryptable) the readable values are incomplete by
 * definition, and demanding a full valid config to disable one would be a dead end. So the disable
 * payload carries only what is actually known and well-formed; the server keeps its stored values
 * for everything omitted and defaults the credential to `keep`.
 */
export type InfraObjectStorageDisableConfig = Partial<
  Omit<InfraObjectStorageConfigInput, 'enabled'>
> & { enabled: false };

export type InfraMailDisableConfig = Partial<Omit<InfraMailConfigInput, 'enabled'>> & {
  enabled: false;
};

export type InfraSettingsDisableConfig = InfraMailDisableConfig | InfraObjectStorageDisableConfig;

/** Present-and-well-formed text, or nothing. Format rules still apply; required-ness does not. */
const knownText = (value: string, max: number): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
};

const knownUrl = (value: string): string | undefined => {
  const trimmed = knownText(value, MAX.url);
  return trimmed && isHttpUrl(trimmed) ? trimmed : undefined;
};

const knownPort = (value: string): number | undefined => {
  const trimmed = value.trim();
  const port = Number(trimmed);
  return trimmed.length > 0 && Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
};

export const toObjectStorageDisableConfig = (
  draft: ObjectStorageDraft,
): InfraObjectStorageDisableConfig => {
  const expire = Number(draft.previewUrlExpireIn.trim());
  const accessKeyId = knownText(draft.accessKeyId, MAX.accessKeyId);
  const bucket = knownText(draft.bucket, MAX.bucket);
  const endpoint = knownUrl(draft.endpoint);
  const region = knownText(draft.region, MAX.region);
  const publicDomain = knownUrl(draft.publicDomain);

  return {
    enabled: false,
    forcePathStyle: draft.forcePathStyle,
    // Explicit rather than relying on the schema default — the stored credential is untouched.
    secretAccessKey: { action: 'keep' },
    setAcl: draft.setAcl,
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(bucket ? { bucket } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(region ? { region } : {}),
    ...(publicDomain ? { publicDomain } : {}),
    ...(Number.isInteger(expire) &&
    expire >= MIN_PREVIEW_URL_EXPIRE_IN &&
    expire <= MAX_PREVIEW_URL_EXPIRE_IN
      ? { previewUrlExpireIn: expire }
      : {}),
  };
};

export const toMailDisableConfig = (draft: MailDraft): InfraMailDisableConfig => {
  const fromAddress = knownText(draft.fromAddress, MAX.fromAddress);
  const senderName = knownText(draft.senderName, MAX.senderName);
  const host = knownText(draft.host, MAX.host);
  const port = knownPort(draft.port);
  const user = knownText(draft.user, MAX.user);
  // The nested object has no optional members of its own, so it is sent whole or not at all.
  const smtpKnown = draft.provider === 'smtp' && host !== undefined && port !== undefined && user;

  return {
    enabled: false,
    provider: draft.provider,
    ...(fromAddress && isEmail(fromAddress) ? { fromAddress } : {}),
    ...(senderName ? { senderName } : {}),
    ...(draft.provider === 'resend' ? { resend: { apiKey: { action: 'keep' } } } : {}),
    ...(smtpKnown
      ? { smtp: { host: host!, pass: { action: 'keep' }, port: port!, secure: draft.secure, user } }
      : {}),
  };
};

export const settleObjectStorageDraft = (draft: ObjectStorageDraft): ObjectStorageDraft => ({
  ...draft,
  secretAccessKey: settleSecret(draft.secretAccessKey),
});

export const settleMailDraft = (draft: MailDraft): MailDraft => ({
  ...draft,
  pass: settleSecret(draft.pass),
  resendApiKey: settleSecret(draft.resendApiKey),
});

export const toMailConfig = (draft: MailDraft): InfraMailConfigInput => ({
  enabled: true,
  fromAddress: draft.fromAddress.trim(),
  provider: draft.provider,
  ...(optionalText(draft.senderName) ? { senderName: draft.senderName.trim() } : {}),
  ...(draft.provider === 'smtp'
    ? {
        smtp: {
          host: draft.host.trim(),
          pass: deriveSecretAction(draft.pass),
          port: Number(draft.port.trim()),
          secure: draft.secure,
          user: draft.user.trim(),
        },
      }
    : { resend: { apiKey: deriveSecretAction(draft.resendApiKey) } }),
});
