/**
 * EasyAuth permission snapshot HTTP client.
 * Static App Token only (eat_ prefix). Never logs the token.
 */
import type { EasyauthRuntimeConfig } from '../config/easyauth';
import { parseEasyauthConfig } from '../config/easyauth';

export interface EasyauthGrantItem {
  permission: string;
  scope?: string;
  source_key?: string;
  source_type?: string;
}

export interface EasyauthGroupItem {
  key: string;
  kind?: string;
  name?: string;
}

export interface EasyauthPermissionSnapshot {
  app_key: string;
  catalog_version: number;
  expires_at?: string;
  grant_version: number;
  grants: EasyauthGrantItem[];
  groups: EasyauthGroupItem[];
  snapshot_version: string;
  user_id: string;
}

export class EasyauthClientError extends Error {
  readonly kind: 'integration' | 'forbidden' | 'unauthorized' | 'malformed';

  constructor(message: string, kind: EasyauthClientError['kind'] = 'integration') {
    super(message);
    this.name = 'EasyauthClientError';
    this.kind = kind;
  }
}

export class EasyauthPermissionClient {
  private readonly config: EasyauthRuntimeConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: { config?: EasyauthRuntimeConfig; fetchImpl?: typeof fetch }) {
    this.config = options?.config ?? parseEasyauthConfig();
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  get appKey(): string {
    return this.config.appKey;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  async fetchPermissionSnapshot(externalUserId: string): Promise<EasyauthPermissionSnapshot> {
    if (!this.config.baseUrl) {
      throw new EasyauthClientError('EASYAUTH_BASE_URL is not configured');
    }
    if (!this.config.appToken) {
      throw new EasyauthClientError('EASYAUTH_APP_TOKEN is not configured');
    }

    const url = `${this.config.baseUrl}/api/v1/apps/${encodeURIComponent(this.config.appKey)}/users/${encodeURIComponent(externalUserId)}/permissions`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.appToken}`,
        },
        method: 'GET',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new EasyauthClientError(
        `EasyAuth permission query failed: ${error instanceof Error ? error.message : 'network'}`,
      );
    }

    if (response.status === 401) {
      throw new EasyauthClientError('EasyAuth app credential is unauthorized', 'unauthorized');
    }
    if (response.status === 403) {
      throw new EasyauthClientError('EasyAuth app credential is forbidden', 'forbidden');
    }
    if (response.status >= 500) {
      throw new EasyauthClientError('EasyAuth upstream service failed');
    }
    if (response.status >= 400) {
      throw new EasyauthClientError(`EasyAuth permission query returned HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new EasyauthClientError('EasyAuth permission response is malformed', 'malformed');
    }

    return normalizeSnapshot(body, this.config.appKey, externalUserId);
  }
}

const normalizeSnapshot = (
  body: unknown,
  appKey: string,
  externalUserId: string,
): EasyauthPermissionSnapshot => {
  if (!body || typeof body !== 'object') {
    throw new EasyauthClientError('EasyAuth permission response is malformed', 'malformed');
  }
  const raw = body as Record<string, unknown>;
  const grantsRaw = Array.isArray(raw.grants) ? raw.grants : [];
  const groupsRaw = Array.isArray(raw.groups) ? raw.groups : [];

  const grants: EasyauthGrantItem[] = grantsRaw
    .filter((g): g is Record<string, unknown> => Boolean(g) && typeof g === 'object')
    .map((g) => ({
      permission: String(g.permission ?? ''),
      scope: g.scope != null ? String(g.scope) : undefined,
      source_key: g.source_key != null ? String(g.source_key) : undefined,
      source_type: g.source_type != null ? String(g.source_type) : undefined,
    }))
    .filter((g) => g.permission);

  const groups: EasyauthGroupItem[] = groupsRaw
    .filter((g): g is Record<string, unknown> => Boolean(g) && typeof g === 'object')
    .map((g) => ({
      key: String(g.key ?? ''),
      kind: g.kind != null ? String(g.kind) : undefined,
      name: g.name != null ? String(g.name) : undefined,
    }))
    .filter((g) => g.key);

  const snapshot: EasyauthPermissionSnapshot = {
    app_key: String(raw.app_key ?? appKey),
    catalog_version: Number(raw.catalog_version ?? 0) || 0,
    expires_at: raw.expires_at != null ? String(raw.expires_at) : undefined,
    grant_version: Number(raw.grant_version ?? 0) || 0,
    grants,
    groups,
    snapshot_version: String(raw.snapshot_version ?? '0'),
    user_id: String(raw.user_id ?? externalUserId),
  };

  if (snapshot.app_key !== appKey) {
    throw new EasyauthClientError('EasyAuth response app_key mismatch', 'forbidden');
  }

  return snapshot;
};
