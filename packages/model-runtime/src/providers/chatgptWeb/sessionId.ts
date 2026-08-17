import { sha256 } from '@noble/hashes/sha2.js';

import type { RuntimeBrowserDeviceProfile } from '../../browserProfile';
import { DEFAULT_BROWSER_DEVICE_PROFILE } from '../../browserProfile';
import { bytesToHex, utf8Encode } from './binary';

/**
 * Private hop-by-hop header. The ChatGPT Web runtime and the server oauth
 * service set this to the connection's `deviceId` so the curl-impersonate
 * transport can pick a Netscape cookie jar. The transport MUST strip it
 * before spawning curl and MUST never forward it upstream.
 */
export const COOKIE_JAR_HEADER = 'X-AIHub-Cookie-Jar';

/**
 * Stable `OAI-Session-Id` for a connection and browser profile. Refreshing the
 * platform profile deliberately produces a new upstream session identity.
 */
export const deriveSessionId = (
  deviceId: string,
  profile: Pick<RuntimeBrowserDeviceProfile, 'id'> = DEFAULT_BROWSER_DEVICE_PROFILE,
): string => {
  const digest = sha256(utf8Encode(`${deviceId}:${profile.id}:session`));
  const bytes = new Uint8Array(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
