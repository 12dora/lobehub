import { ModelProvider } from 'model-bank';

import type { AiCatalogCredentialVault } from './credentialAdapter';
import { AiCatalogValidationError } from './errors';

const hasText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export type CredentialEnv = Record<string, string | undefined>;

const requireOllama = (keyVaults: AiCatalogCredentialVault): void => {
  if (!hasText(keyVaults.baseURL)) {
    throw new AiCatalogValidationError(['Ollama requires an explicit platform endpoint']);
  }
};

const requireBedrock = (keyVaults: AiCatalogCredentialVault): void => {
  const accessPair = hasText(keyVaults.accessKeyId) && hasText(keyVaults.secretAccessKey);
  if ((!accessPair && !hasText(keyVaults.apiKey)) || !hasText(keyVaults.region)) {
    throw new AiCatalogValidationError(['Bedrock credentials are incomplete']);
  }
};

const requireCloudflare = (keyVaults: AiCatalogCredentialVault): void => {
  if (!hasText(keyVaults.apiKey) || !hasText(keyVaults.baseURLOrAccountID)) {
    throw new AiCatalogValidationError(['Cloudflare credentials are incomplete']);
  }
};

const requireComfyUI = (keyVaults: AiCatalogCredentialVault): void => {
  if (!hasText(keyVaults.baseURL)) {
    throw new AiCatalogValidationError(['ComfyUI requires an explicit platform endpoint']);
  }
  const authType = keyVaults.authType ?? 'none';
  if (authType === 'basic' && (!hasText(keyVaults.username) || !hasText(keyVaults.password))) {
    throw new AiCatalogValidationError(['ComfyUI basic credentials are incomplete']);
  }
  if (authType === 'bearer' && !hasText(keyVaults.apiKey)) {
    throw new AiCatalogValidationError(['ComfyUI bearer credential is missing']);
  }
  if (
    authType === 'custom' &&
    (!keyVaults.customHeaders || Object.keys(keyVaults.customHeaders).length === 0)
  ) {
    throw new AiCatalogValidationError(['ComfyUI custom headers are missing']);
  }
};

const requireChatGPT = (keyVaults: AiCatalogCredentialVault): void => {
  // Shared platform OAuth connection: rotating refresh token + Codex account id.
  if (
    !hasText(keyVaults.oauthAccessToken) ||
    !hasText(keyVaults.oauthRefreshToken) ||
    !hasText(keyVaults.oauthAccountId)
  ) {
    throw new AiCatalogValidationError(['ChatGPT shared OAuth connection is incomplete']);
  }
};

const requireChatGPTWeb = (keyVaults: AiCatalogCredentialVault): void => {
  /**
   * Only the access token is required. Unlike the Codex `chatgpt` provider, this one
   * ALSO supports pasting a bare access token (no refresh grant, no account id from
   * an id_token), and a connection that can chat must not be rejected as incomplete
   * just because it cannot auto-renew — the UI states that plainly instead.
   */
  if (!hasText(keyVaults.oauthAccessToken)) {
    throw new AiCatalogValidationError(['ChatGPT Web shared OAuth connection is incomplete']);
  }
};

const requireGithubCopilot = (keyVaults: AiCatalogCredentialVault): void => {
  if (
    !hasText(keyVaults.apiKey) &&
    !hasText(keyVaults.bearerToken) &&
    !hasText(keyVaults.oauthAccessToken)
  ) {
    throw new AiCatalogValidationError(['GitHub Copilot credential is missing']);
  }
};

const requireSharedOAuth =
  (displayName: string) =>
  (keyVaults: AiCatalogCredentialVault): void => {
    // Shared platform OAuth connection: rotating refresh token.
    if (!hasText(keyVaults.oauthAccessToken) || !hasText(keyVaults.oauthRefreshToken)) {
      throw new AiCatalogValidationError([`${displayName} shared OAuth connection is incomplete`]);
    }
  };

const requireSuperGrok = requireSharedOAuth('SuperGrok');

const requireVertexAI = (keyVaults: AiCatalogCredentialVault): void => {
  if (!hasText(keyVaults.apiKey)) {
    throw new AiCatalogValidationError(['Vertex AI service account is missing']);
  }
  try {
    const credentials: unknown = JSON.parse(keyVaults.apiKey);
    if (
      !credentials ||
      typeof credentials !== 'object' ||
      !('client_email' in credentials) ||
      !('private_key' in credentials) ||
      !('project_id' in credentials)
    ) {
      throw new Error('invalid service account');
    }
  } catch {
    throw new AiCatalogValidationError(['Vertex AI service account is invalid']);
  }
};

export const requireApiKey = (keyVaults: AiCatalogCredentialVault): void => {
  if (!hasText(keyVaults.apiKey)) {
    throw new AiCatalogValidationError(['Provider API key is missing']);
  }
};

export const REQUIRED_CREDENTIALS: Partial<Record<string, (kv: AiCatalogCredentialVault) => void>> =
  {
    [ModelProvider.Ollama]: requireOllama,
    [ModelProvider.Bedrock]: requireBedrock,
    [ModelProvider.Cloudflare]: requireCloudflare,
    [ModelProvider.ComfyUI]: requireComfyUI,
    [ModelProvider.ChatGPT]: requireChatGPT,
    [ModelProvider.ChatGPTWeb]: requireChatGPTWeb,
    [ModelProvider.GithubCopilot]: requireGithubCopilot,
    [ModelProvider.Grok]: requireSharedOAuth('Grok'),
    [ModelProvider.Cursor]: requireSharedOAuth('Cursor'),
    [ModelProvider.SuperGrok]: requireSuperGrok,
    [ModelProvider.VertexAI]: requireVertexAI,
  };
