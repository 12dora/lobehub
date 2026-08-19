import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import type { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogSecretManager } from '../../services/aiCatalog/secretManager';
import {
  buildChatGPTWebBrowserSessionAccountId,
  wipeChatGPTWebCookieJar,
} from '../../services/chatgptWeb/oauthService';
import { asVaultString } from './aiProviderOAuthSupport';

/**
 * Device id for the ChatGPT Web jar, persisted beside the jar itself.
 *
 * apply commits the vault clear and then a post-commit getDetail can fail
 * because the database went away. The verification read then fails too, and a
 * retry sees an empty vault. The id has to live outside the row or the jar is
 * stranded while a historical revision can still resolve its secret version.
 */
const CHATGPT_WEB_PENDING_WIPE_DIR = nodePath.join(tmpdir(), 'aihub-chatgptweb-jars');

const chatgptWebPendingWipePath = (providerId: string) =>
  nodePath.join(CHATGPT_WEB_PENDING_WIPE_DIR, `pending-wipe-${providerId}`);

export const persistChatGPTWebPendingWipe = (providerId: string, deviceId: string): void => {
  try {
    mkdirSync(CHATGPT_WEB_PENDING_WIPE_DIR, { mode: 0o700, recursive: true });
    writeFileSync(chatgptWebPendingWipePath(providerId), deviceId, { mode: 0o600 });
  } catch {
    // Best-effort: the in-memory capture still covers this request.
  }
};

export const readChatGPTWebPendingWipe = (providerId: string): string | undefined => {
  try {
    const deviceId = readFileSync(chatgptWebPendingWipePath(providerId), 'utf8').trim();
    return deviceId || undefined;
  } catch {
    return undefined;
  }
};

export const clearChatGPTWebPendingWipe = (providerId: string): void => {
  try {
    unlinkSync(chatgptWebPendingWipePath(providerId));
  } catch {
    // Already gone.
  }
};

export const decryptChatGPTWebDeviceId = async (
  ciphertext: string | null | undefined,
): Promise<string | undefined> => {
  if (!ciphertext) return undefined;
  const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise();
  if (!secrets) return undefined;
  const keyVaults = await new AiCatalogSecretManager(secrets).decrypt(ciphertext);
  return asVaultString(keyVaults.oauthDeviceId);
};

export const captureChatGPTWebDeviceId = async ({
  draftId,
  repo,
}: {
  draftId: string;
  repo: PlatformAiCatalogRepository;
}): Promise<string | undefined> => {
  let chatgptWebDeviceId: string | undefined;
  try {
    const provider = await repo.getProvider(draftId);
    chatgptWebDeviceId = await decryptChatGPTWebDeviceId(provider?.encryptedKeyVaults);
    if (!chatgptWebDeviceId) {
      const published = await repo.getLatestPublishedProviderRevision(draftId);
      if (published?.secretFingerprint) {
        const version = await repo.getProviderSecretVersion(draftId, published.secretFingerprint);
        chatgptWebDeviceId = await decryptChatGPTWebDeviceId(version?.ciphertext);
      }
    }
  } catch {
    // Best-effort: never fail the disconnect on a vault-read error.
  }
  chatgptWebDeviceId ??= readChatGPTWebPendingWipe(draftId);
  return chatgptWebDeviceId;
};

export const wipeChatGPTWebJarBestEffort = (
  deviceId: string | undefined,
  accountId?: string,
): void => {
  if (!deviceId && !accountId) return;
  try {
    wipeChatGPTWebCookieJar(deviceId, accountId);
  } catch {
    // Best-effort: never fail the disconnect on a jar unlink.
  }
};

export type DisconnectApplyRecovery =
  { kind: 'cleared'; revision: number } | { kind: 'live' } | { kind: 'unknown' };

export const recoverDisconnectAfterApplyFailure = async ({
  baseRevision,
  capturedDeviceId,
  draftId,
  repo,
}: {
  baseRevision: number;
  capturedDeviceId: string | undefined;
  draftId: string;
  repo: PlatformAiCatalogRepository;
}): Promise<DisconnectApplyRecovery> => {
  type ClearOutcome = { revision: number } | 'live' | 'unknown';
  let outcome: ClearOutcome;
  try {
    const provider = await repo.getProvider(draftId);
    outcome = provider?.encryptedKeyVaults
      ? 'live'
      : { revision: provider?.revision ?? baseRevision };
  } catch {
    outcome = 'unknown';
  }

  if (outcome === 'live') {
    clearChatGPTWebPendingWipe(draftId);
  } else {
    wipeChatGPTWebJarBestEffort(
      capturedDeviceId ?? readChatGPTWebPendingWipe(draftId),
      buildChatGPTWebBrowserSessionAccountId({ kind: 'platform', providerId: draftId }),
    );
  }

  if (typeof outcome === 'object') {
    clearChatGPTWebPendingWipe(draftId);
    return { kind: 'cleared', revision: outcome.revision };
  }

  return outcome === 'live' ? { kind: 'live' } : { kind: 'unknown' };
};
