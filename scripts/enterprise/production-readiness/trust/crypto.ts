/**
 * Ed25519 sign/verify using Node crypto only (no new dependency).
 */
import {
  createHash,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';

export interface Ed25519KeyPair {
  /** PKCS8 private key, base64 — test fixtures only; never ship production private keys. */
  privateKeyBase64: string;
  /** SPKI public key, base64. */
  publicKeyBase64: string;
  /** SHA-256 fingerprint of the raw public key DER (lowercase hex). */
  publicKeyFingerprint: string;
}

export const fingerprintPublicKeyBase64 = (publicKeyBase64: string): string => {
  const der = Buffer.from(publicKeyBase64, 'base64');
  return createHash('sha256').update(der).digest('hex');
};

export const generateEd25519KeyPair = (): Ed25519KeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const privateKeyBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  return {
    privateKeyBase64,
    publicKeyBase64,
    publicKeyFingerprint: fingerprintPublicKeyBase64(publicKeyBase64),
  };
};

export const signPayloadBytes = (payload: Buffer, privateKeyBase64: string): string => {
  const key = {
    format: 'der' as const,
    key: Buffer.from(privateKeyBase64, 'base64'),
    type: 'pkcs8' as const,
  };
  return nodeSign(null, payload, key).toString('base64');
};

export const verifyPayloadBytes = (
  payload: Buffer,
  signatureBase64: string,
  publicKeyBase64: string,
): boolean => {
  try {
    const key = {
      format: 'der' as const,
      key: Buffer.from(publicKeyBase64, 'base64'),
      type: 'spki' as const,
    };
    return nodeVerify(null, payload, key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
};
