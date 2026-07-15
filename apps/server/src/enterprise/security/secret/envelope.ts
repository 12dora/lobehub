import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { CIPHERTEXT_PREFIX, ENVELOPE_ALG, ENVELOPE_VERSION } from './config';
import { secretInvalidInput, secretNotReadable } from './errors';

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DEK_BYTES = 32;

/** Self-describing envelope payload (versioned for future rotation). */
export interface EnvelopeV1 {
  alg: typeof ENVELOPE_ALG;
  /** Data ciphertext (base64url). */
  ct: string;
  /** Wrapped DEK ciphertext (base64url). */
  edk: string;
  /** IV for DEK wrap (base64url). */
  eiv: string;
  /** Auth tag for DEK wrap (base64url). */
  etag: string;
  /** IV for data encryption (base64url). */
  iv: string;
  /** KEK key id used to wrap the DEK. */
  kid: string;
  /** Auth tag for data (base64url). */
  tag: string;
  v: typeof ENVELOPE_VERSION;
}

const b64url = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString('base64url');

const fromB64url = (s: string): Buffer => {
  try {
    return Buffer.from(s, 'base64url');
  } catch {
    throw secretInvalidInput('Envelope field is not valid base64url');
  }
};

const aesGcmEncrypt = (
  key: Uint8Array,
  plaintext: Uint8Array,
): { iv: Buffer; tag: Buffer; ct: Buffer } => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ct, iv, tag };
};

const aesGcmDecrypt = (key: Uint8Array, iv: Buffer, tag: Buffer, ct: Buffer): Buffer => {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw secretNotReadable();
  }
};

/**
 * Build ciphertext string: `aihub.secret.v1.<base64url(JSON EnvelopeV1)>`
 * Self-describing: version, alg, kid support future KEK rotation without DB schema.
 */
export const sealEnvelope = (params: {
  kek: Uint8Array;
  keyId: string;
  plaintext: Uint8Array;
}): string => {
  if (params.kek.length !== DEK_BYTES) {
    throw secretInvalidInput(`KEK must be ${DEK_BYTES} bytes`);
  }

  const dek = randomBytes(DEK_BYTES);
  try {
    const data = aesGcmEncrypt(dek, params.plaintext);
    const wrapped = aesGcmEncrypt(params.kek, dek);

    const envelope: EnvelopeV1 = {
      alg: ENVELOPE_ALG,
      ct: b64url(data.ct),
      edk: b64url(wrapped.ct),
      eiv: b64url(wrapped.iv),
      etag: b64url(wrapped.tag),
      iv: b64url(data.iv),
      kid: params.keyId,
      tag: b64url(data.tag),
      v: ENVELOPE_VERSION,
    };

    const payload = b64url(Buffer.from(JSON.stringify(envelope), 'utf8'));
    return `${CIPHERTEXT_PREFIX}.v${ENVELOPE_VERSION}.${payload}`;
  } finally {
    dek.fill(0);
  }
};

export const parseEnvelopeString = (ciphertext: string): EnvelopeV1 => {
  if (typeof ciphertext !== 'string' || !ciphertext.startsWith(`${CIPHERTEXT_PREFIX}.`)) {
    throw secretInvalidInput('Ciphertext is not a platform secret envelope', {
      prefix: CIPHERTEXT_PREFIX,
    });
  }

  const parts = ciphertext.split('.');
  // aihub.secret.v1.<payload>
  if (parts.length !== 4 || parts[0] !== 'aihub' || parts[1] !== 'secret') {
    throw secretInvalidInput('Malformed secret envelope structure');
  }

  const versionToken = parts[2]; // v1
  if (!/^v\d+$/.test(versionToken)) {
    throw secretInvalidInput(`Unrecognized envelope version token: ${versionToken}`);
  }
  const version = Number(versionToken.slice(1));
  if (version !== ENVELOPE_VERSION) {
    throw secretInvalidInput(`Unsupported secret envelope version: ${version}`, {
      supported: ENVELOPE_VERSION,
      version,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromB64url(parts[3]).toString('utf8'));
  } catch {
    throw secretInvalidInput('Secret envelope payload is not valid JSON');
  }

  const env = parsed as Partial<EnvelopeV1>;
  if (
    env.v !== ENVELOPE_VERSION ||
    env.alg !== ENVELOPE_ALG ||
    typeof env.kid !== 'string' ||
    typeof env.eiv !== 'string' ||
    typeof env.etag !== 'string' ||
    typeof env.edk !== 'string' ||
    typeof env.iv !== 'string' ||
    typeof env.tag !== 'string' ||
    typeof env.ct !== 'string'
  ) {
    throw secretInvalidInput('Secret envelope missing required fields');
  }

  return env as EnvelopeV1;
};

export const openEnvelope = (params: { kek: Uint8Array; envelope: EnvelopeV1 }): Buffer => {
  if (params.kek.length !== DEK_BYTES) {
    throw secretInvalidInput(`KEK must be ${DEK_BYTES} bytes`);
  }

  const eiv = fromB64url(params.envelope.eiv);
  const etag = fromB64url(params.envelope.etag);
  const edk = fromB64url(params.envelope.edk);
  const iv = fromB64url(params.envelope.iv);
  const tag = fromB64url(params.envelope.tag);
  const ct = fromB64url(params.envelope.ct);

  if (eiv.length !== IV_BYTES || iv.length !== IV_BYTES) {
    throw secretInvalidInput('Invalid IV length in envelope');
  }
  if (etag.length !== AUTH_TAG_BYTES || tag.length !== AUTH_TAG_BYTES) {
    throw secretInvalidInput('Invalid auth tag length in envelope');
  }

  const dek = new Uint8Array(aesGcmDecrypt(params.kek, eiv, etag, edk));
  try {
    return aesGcmDecrypt(dek, iv, tag, ct);
  } finally {
    dek.fill(0);
  }
};

export const getEnvelopeKeyId = (ciphertext: string): string => parseEnvelopeString(ciphertext).kid;
