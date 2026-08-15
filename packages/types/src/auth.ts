export interface ClientSecretPayload {
  /**
   * Represents the user's API key
   */
  apiKey?: string;
  /**
   * ComfyUI specific authentication fields
   */
  authType?: string;

  awsAccessKeyId?: string;

  awsRegion?: string;

  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  azureApiVersion?: string;
  /**
   * Represents the endpoint of provider
   */
  baseURL?: string;

  bearerToken?: string;

  bearerTokenExpiresAt?: number;

  /**
   * ChatGPT account identifier associated with an OAuth access token.
   */
  chatgptAccountId?: string;
  /**
   * Stable per-connection device identifier (`oai-device-id`) used by the
   * ChatGPT Web protocol. Not a secret, but it must stay stable across requests
   * for the same connected account.
   */
  chatgptDeviceId?: string;
  cloudflareBaseURLOrAccountID?: string;
  customHeaders?: Record<string, string>;
  /**
   * GitHub Copilot OAuth fields
   */
  oauthAccessToken?: string;
  password?: string;

  runtimeProvider?: string;
  /**
   * user id
   * in client db mode it's a uuid
   * in server db mode it's a user id
   */
  userId?: string;
  username?: string;

  vertexAIRegion?: string;
}
