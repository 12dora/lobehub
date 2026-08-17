import { sha1 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';

const encoder = new TextEncoder();

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const UUID_V4_RE = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const MAX_UUID_V7_TIMESTAMP_MS = 0xffff_ffff_ffff;

const NAMESPACE_OID_BYTES = new Uint8Array([
  0x6b, 0xa7, 0xb8, 0x12, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
]);

const utf8Encode = (input: string): Uint8Array => encoder.encode(input);

const bytesToHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
};

const formatUuid = (bytes: Uint8Array): string => {
  if (bytes.length !== 16) throw new TypeError('UUID bytes must be exactly 16 bytes');
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const isUuid = (value: string): boolean => UUID_RE.test(value);

export const isUuidV4 = (value: string): boolean => UUID_V4_RE.test(value);

export const assertBrowserInstallationId = (installationId: string): string => {
  if (!isUuidV4(installationId)) throw new Error('Browser installationId must be a UUIDv4');
  return installationId.toLowerCase();
};

export const deriveUuidV5 = (name: string): string => {
  const nameBytes = utf8Encode(name);
  const input = new Uint8Array(NAMESPACE_OID_BYTES.length + nameBytes.length);
  input.set(NAMESPACE_OID_BYTES);
  input.set(nameBytes, NAMESPACE_OID_BYTES.length);
  const bytes = new Uint8Array(sha1(input).subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
};

export const deriveGrokAgentId = (installationId: string): string =>
  deriveUuidV5(`aihub-grok-agent:${assertBrowserInstallationId(installationId)}`);

export const deriveStableMachineId = (installationId: string, purpose: string): string => {
  if (!purpose) throw new Error('Stable machine id purpose must not be empty');
  return bytesToHex(
    sha256(utf8Encode(`${purpose}:${assertBrowserInstallationId(installationId)}`)),
  );
};

/**
 * UUIDv7-SHAPED conversation id: the 48 high bits are `firstSeenMs`, the rest is
 * derived from `key`.
 *
 * `firstSeenMs` must be a REAL time — when this conversation actually started. A
 * derived or constant "installation epoch" would stamp every conversation of an
 * installation with the same 48 bits, which is both trivially recognisable and
 * impossible for a real client whose session ids advance with the clock. The
 * server keeps the first-seen time per conversation (topic `createdAt`, else the
 * first sighting) and passes it here.
 */
export const deriveConversationSessionId = (key: string, firstSeenMs: number): string => {
  if (!key) throw new Error('Conversation session key must not be empty');
  if (
    !Number.isSafeInteger(firstSeenMs) ||
    firstSeenMs < 0 ||
    firstSeenMs > MAX_UUID_V7_TIMESTAMP_MS
  )
    throw new Error('Conversation session timestamp must fit in 48 bits');

  const digest = sha256(utf8Encode(key));
  const bytes = new Uint8Array(16);
  let timestamp = firstSeenMs;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes.set(digest.subarray(0, 10), 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
};

/**
 * Deterministic UUIDv4-SHAPED id for a caller that must supply a "random" uuid but
 * needs the same value again for the same name (e.g. the Cursor CLI's
 * `--new-session-id`, which validates the v4 shape and would otherwise mint a fresh
 * chat id on every turn of one conversation).
 *
 * It is NOT a random v4 and must never be used where unpredictability matters; it is
 * a stable per-conversation label derived from a name that already contains the
 * installation id.
 */
export const deriveUuidV4FromName = (name: string): string => {
  if (!name) throw new Error('Deterministic UUIDv4 name must not be empty');
  const bytes = new Uint8Array(sha256(utf8Encode(name)).subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
};

/** Stable Cursor CLI chat id for one AIHub conversation on one installation. */
export const deriveCursorConversationId = (
  installationId: string,
  conversationKey: string,
): string =>
  deriveUuidV4FromName(
    `aihub-cursor-chat:${assertBrowserInstallationId(installationId)}:${conversationKey}`,
  );
